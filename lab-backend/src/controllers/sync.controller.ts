import { Response } from 'express';
import { getDb, persist } from '../store/db';
import { AuthRequest } from '../middleware/auth.middleware';
import { Platform } from '../store/types';
import { applyPlatformPublish } from './publish.service';
import { newId } from '../lib/ids';

function revisionDe(file: { platformRev?: Partial<Record<Platform, number>> }, platform: Platform): number {
  return file.platformRev?.[platform] ?? 0;
}

function estadoDeArchivo(userId: string, file: ReturnType<typeof getDb>['files'][number]) {
  const db = getDb();
  const platformRev = Object.fromEntries(PLATFORMS.map(p => [p, revisionDe(file, p)]));
  const platformStates = PLATFORMS.flatMap(platform => {
    if (file.platformsDiscarded.includes(platform)) return [{ platform, state: 'discarded' }];
    if (!file.platforms.includes(platform)) return [];
    const vivos = db.platformVideos.filter(v => v.userId === userId && v.platform === platform && v.linkedFileId === file.id);
    return [{ platform, state: vivos.length === 1 ? 'confirmed' : 'badge_only' }];
  });
  const platformLinks = PLATFORMS.flatMap(platform => {
    const vivos = db.platformVideos.filter(v => v.userId === userId && v.platform === platform && v.linkedFileId === file.id);
    if (vivos.length === 0) return [];
    if (vivos.length > 1) return [{ platform, platformId: null, coherente: false, ambiguo: true }];
    const video = vivos[0];
    return [{
      platform, platformId: video.platformId,
      coherente: typeof video.linkVersion === 'number' && video.linkVersion === platformRev[platform],
      ambiguo: false,
    }];
  });
  return { platformRev, platformStates, platformLinks };
}

const PLATFORMS: Platform[] = ['youtube', 'instagram', 'tiktok'];
const DEFAULT_INTERVAL: Record<Platform, number> = { youtube: 4, instagram: 3, tiktok: 3 };
const CONTENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// GET /api/sync/calendar-config -- mismo shape que backend/src/controllers/sync.controller.ts::getCalendarConfig,
// simplificado (sin el recálculo dinámico contra PlatformVideoModel: en el
// Laboratorio el override YA es la fuente de verdad, no hay reconciliación).
export const getCalendarConfig = (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const userId = req.user!.id;

  const result = PLATFORMS.map((platform) => {
    const cfg = db.calendarConfigs.find(c => c.userId === userId && c.platform === platform);
    const nextFile = cfg?.nextVideoId ? db.files.find(f => f.id === cfg.nextVideoId) : undefined;
    return {
      platform,
      lastPublishedTitle: cfg?.lastPublishedTitle ?? '',
      lastPublishedDate: cfg?.lastPublishedDate ?? '',
      intervalDays: cfg?.intervalDays ?? DEFAULT_INTERVAL[platform],
      lastVideoId: cfg?.lastVideoId ?? null,
      nextVideoId: cfg?.nextVideoId ?? null,
      nextRemoteLibraryVideoId: null,
      nextVideo: nextFile ? {
        fileId: nextFile.id,
        contentId: null,
        title: nextFile.fileName,
        duration: `${Math.floor(nextFile.durationSeconds / 60)}:${String(nextFile.durationSeconds % 60).padStart(2, '0')}`,
        remoteLibraryVideoId: null,
        thumbnailStoredFileName: null,
      } : null,
    };
  });
  res.json(result);
};

// PATCH /api/sync/calendar-config/:platform
export const updateCalendarConfig = (req: AuthRequest, res: Response): void => {
  const { platform } = req.params as { platform: Platform };
  if (!PLATFORMS.includes(platform)) { res.status(400).json({ message: 'Plataforma no válida' }); return; }
  const { lastPublishedDate, lastPublishedTitle, intervalDays, lastVideoId, nextVideoId } = req.body ?? {};

  const db = getDb();
  const userId = req.user!.id;
  let cfg = db.calendarConfigs.find(c => c.userId === userId && c.platform === platform);
  if (!cfg) {
    cfg = { userId, platform, lastPublishedTitle: '', lastPublishedDate: '', intervalDays: DEFAULT_INTERVAL[platform], lastVideoId: null, nextVideoId: null };
    db.calendarConfigs.push(cfg);
  }
  if (lastPublishedDate !== undefined) cfg.lastPublishedDate = lastPublishedDate;
  if (lastPublishedTitle !== undefined) cfg.lastPublishedTitle = lastPublishedTitle;
  if (intervalDays !== undefined) cfg.intervalDays = intervalDays;
  if (lastVideoId !== undefined) cfg.lastVideoId = lastVideoId;
  if (nextVideoId !== undefined) cfg.nextVideoId = nextVideoId;
  persist();
  res.json({ ok: true });
};

// POST /api/sync/calendar-config/:platform/skip-next
export const skipNextCalendarVideo = (req: AuthRequest, res: Response): void => {
  const { platform } = req.params as { platform: Platform };
  const { fileId } = req.body as { fileId?: string };
  if (!PLATFORMS.includes(platform) || !fileId) { res.status(400).json({ message: 'Plataforma o video no válido.' }); return; }

  const db = getDb();
  const userId = req.user!.id;
  const file = db.files.find(f => f.id === fileId && f.userId === userId);
  if (!file) { res.status(404).json({ message: 'Video no encontrado.' }); return; }
  if (!file.platformsDiscarded.includes(platform)) file.platformsDiscarded.push(platform);

  const next = db.files.find(f => f.userId === userId && !f.platforms.includes(platform) && !f.platformsDiscarded.includes(platform));
  let cfg = db.calendarConfigs.find(c => c.userId === userId && c.platform === platform);
  if (!cfg) {
    cfg = { userId, platform, lastPublishedTitle: '', lastPublishedDate: '', intervalDays: DEFAULT_INTERVAL[platform], lastVideoId: null, nextVideoId: null };
    db.calendarConfigs.push(cfg);
  }
  cfg.nextVideoId = next?.id ?? null;
  persist();
  res.json({ ok: true, nextVideoId: cfg.nextVideoId });
};

// GET /api/sync/group-stats?limit=&platform=
export const getGroupStats = (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const userId = req.user!.id;
  const limit = Math.min(parseInt(req.query.limit as string) || 5, 20);
  const platform = typeof req.query.platform === 'string' ? req.query.platform as Platform : undefined;
  if (platform && !PLATFORMS.includes(platform)) { res.status(400).json({ message: 'Plataforma no válida' }); return; }

  const files = db.files
    .filter(f => f.userId === userId)
    .filter(f => platform ? f.platforms.includes(platform) : PLATFORMS.every(p => f.platforms.includes(p)))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  const items = files.map(f => {
    const pvs = db.platformVideos.filter(pv => pv.linkedFileId === f.id);
    const platforms: Record<string, unknown> = {};
    for (const pv of pvs) {
      if (platform && pv.platform !== platform) continue;
      platforms[pv.platform] = {
        platformId: pv.platformId, platformUrl: pv.platformUrl, title: pv.title, thumbnail: pv.thumbnail,
        views: pv.views, likes: pv.likes, comments: pv.comments,
      };
    }
    return { fileId: f.id, fileName: f.fileName, remoteLibraryVideoId: null, thumbnailStoredFileName: null, fecha_creacion: f.createdAt, platforms };
  });
  res.json({ items });
};

// GET /api/sync/file-stats?fileId=&fileName=
export const getFileStats = (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const userId = req.user!.id;
  const fileId = typeof req.query.fileId === 'string' ? req.query.fileId : undefined;
  const fileName = typeof req.query.fileName === 'string' ? req.query.fileName : undefined;
  if (!fileId && !fileName) { res.status(400).json({ message: 'fileId o fileName requerido.' }); return; }

  const file = db.files.find(f => f.userId === userId && (f.id === fileId || f.fileName === fileName));
  if (!file) { res.status(404).json({ message: 'No encontrado.' }); return; }

  const pvs = db.platformVideos.filter(pv => pv.linkedFileId === file.id);
  const platforms: Record<string, unknown> = {};
  for (const pv of pvs) {
    platforms[pv.platform] = {
      platformId: pv.platformId, platformUrl: pv.platformUrl, title: pv.title, thumbnail: pv.thumbnail,
      views: pv.views, likes: pv.likes, comments: pv.comments,
    };
  }
  res.json({ fileId: file.id, fileName: file.fileName, fecha_creacion: file.createdAt, remoteLibraryVideoId: null, thumbnailStoredFileName: null, platforms });
};

// GET /api/sync/history?limit=&offset=&platform=
export const getUploadHistory = (req: AuthRequest, res: Response): void => {
  const db = getDb();
  const userId = req.user!.id;
  const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;

  let items = db.uploadHistory.filter(h => h.userId === userId);
  if (platform) items = items.filter(h => h.platform === platform);
  items = items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  const total = items.length;
  const page = items.slice(offset, offset + limit).map(h => ({ ...h, linkedFileId: null, matchStatus: 'manual' }));
  res.json({ items: page, total });
};

// POST /api/sync/history (alias: /api/sync/record-publish) -- lo llaman los
// uploaders mock de iOS/Android/local-backend al terminar una publicación
// simulada. Delega en applyPlatformPublish (publish.service.ts) para que
// catálogo/calendario queden consistentes, igual que la central real.
export const recordUploadEvent = (req: AuthRequest, res: Response): void => {
  const userId = req.user!.id;
  const { deviceId, source, platform, platformId, platformUrl, fileName, title, publishedAt, operationId } = req.body ?? {};
  if (!platform || !platformId) { res.status(400).json({ message: 'platform y platformId son requeridos.' }); return; }

  const db = getDb();
  const publishedAtDate = publishedAt ? new Date(publishedAt).toISOString() : new Date().toISOString();

  const existing = db.uploadHistory.find(h => h.userId === userId && h.platform === platform && h.platformId === platformId);
  if (existing) {
    Object.assign(existing, { deviceId: deviceId ?? existing.deviceId, source: source ?? existing.source, platformUrl: platformUrl ?? existing.platformUrl, fileName: fileName ?? existing.fileName, title: title ?? existing.title, publishedAt: publishedAtDate, operationId: operationId ?? existing.operationId });
  } else {
    db.uploadHistory.push({
      id: `${Date.now()}`, userId, platform, platformId, platformUrl: platformUrl ?? null,
      fileName: fileName ?? null, title: title ?? null, deviceId: deviceId ?? null, source: source ?? null,
      operationId: operationId ?? null, publishedAt: publishedAtDate, createdAt: new Date().toISOString(),
    });
  }

  applyPlatformPublish(userId, { platform, platformId, platformUrl, fileName, title, publishedAt: publishedAtDate });
  persist();
  res.json({ ok: true });
};

// POST /api/sync/resolve-identity — mismo bootstrap determinístico de la
// central, sobre el store aislado del Laboratorio. Nunca resuelve por nombre.
export const resolveIdentity = (req: AuthRequest, res: Response): void => {
  const userId = req.user!.id;
  const { fileName, contentId, deviceId, clientFileId } = req.body ?? {};
  if (!fileName || !deviceId || !clientFileId) {
    res.status(400).json({ message: 'fileName, deviceId y clientFileId son obligatorios.' });
    return;
  }
  if (contentId !== undefined && !CONTENT_ID_RE.test(String(contentId))) {
    res.status(400).json({ message: 'contentId debe ser un UUID.' });
    return;
  }
  const db = getDb();
  let binding = db.identityBindings.find(b => b.userId === userId && b.deviceId === deviceId && b.clientFileId === clientFileId);
  if (!binding) {
    binding = { userId, deviceId, clientFileId, contentId: contentId ?? newId() };
    db.identityBindings.push(binding);
  } else if (contentId && binding.contentId !== contentId) {
    res.status(409).json({ message: 'Ese archivo del cliente ya tiene otra identidad.', reason: 'identity_conflict' });
    return;
  }

  let file = db.files.find(f => f.userId === userId && f.contentId === binding!.contentId);
  if (!file) {
    file = {
      id: newId(), userId, contentId: binding.contentId, fileName,
      durationSeconds: 0, createdAt: new Date().toISOString(),
      platforms: [], platformsDiscarded: [], platformRev: {},
    };
    db.files.push(file);
  }
  const estado = estadoDeArchivo(userId, file);
  persist();
  res.json({
    contentId: binding.contentId,
    platforms: file.platforms,
    platformsDiscarded: file.platformsDiscarded,
    platformStates: estado.platformStates,
    platformLinks: estado.platformLinks,
    platformRev: estado.platformRev,
  });
};

// POST /api/sync/platform-transition — CAS e idempotencia equivalentes a la
// central. Al ser un store JSON de un solo proceso no necesita leases.
export const applyPlatformTransition = (req: AuthRequest, res: Response): void => {
  const userId = req.user!.id;
  const { contentId, platform, action, operationId, baseVersion } = req.body ?? {};
  if (!contentId || !PLATFORMS.includes(platform) || !['discard', 'unlink', 'mark_published'].includes(action)
      || typeof operationId !== 'string' || operationId.trim() === ''
      || !Number.isInteger(baseVersion) || baseVersion < 0) {
    res.status(400).json({ message: 'Transición inválida.' });
    return;
  }
  const db = getDb();
  const previous = db.transitionOps.find(o => o.userId === userId && o.operationId === operationId);
  if (previous) {
    const same = previous.contentId === contentId && previous.platform === platform
      && previous.action === action && previous.baseVersion === baseVersion;
    if (!same) { res.status(422).json({ reason: 'operation_mismatch' }); return; }
    res.json({ ok: true, version: previous.resultVersion, deduplicated: true });
    return;
  }
  const file = db.files.find(f => f.userId === userId && f.contentId === contentId);
  if (!file) { res.status(404).json({ reason: 'not_found' }); return; }
  const current = revisionDe(file, platform);
  if (current !== baseVersion) {
    res.status(409).json({ reason: 'stale', version: current, contentId, platform });
    return;
  }

  if (action === 'discard') {
    file.platforms = file.platforms.filter(p => p !== platform);
    if (!file.platformsDiscarded.includes(platform)) file.platformsDiscarded.push(platform);
  } else if (action === 'unlink') {
    file.platforms = file.platforms.filter(p => p !== platform);
    file.platformsDiscarded = file.platformsDiscarded.filter(p => p !== platform);
  } else {
    if (!file.platforms.includes(platform)) file.platforms.push(platform);
    file.platformsDiscarded = file.platformsDiscarded.filter(p => p !== platform);
  }
  const version = current + 1;
  file.platformRev = { ...(file.platformRev ?? {}), [platform]: version };
  if (action !== 'mark_published') {
    for (const video of db.platformVideos) {
      if (video.userId === userId && video.platform === platform && video.linkedFileId === file.id) {
        video.linkedFileId = null;
        video.linkVersion = version;
      }
    }
  }
  db.transitionOps.push({ userId, operationId, contentId, platform, action, baseVersion, resultVersion: version });
  persist();
  res.json({
    ok: true, fileId: file.id, version, deduplicated: false,
    platforms: file.platforms, platformsDiscarded: file.platformsDiscarded,
  });
};

// POST /api/sync/manual-platform-link — mueve el vínculo y su badge como una
// sola intención durable/idempotente desde la perspectiva del cliente.
export const manualPlatformLink = (req: AuthRequest, res: Response): void => {
  const userId = req.user!.id;
  const { contentId, platform, platformId, platformUrl, title, operationId } = req.body ?? {};
  if (!contentId || !PLATFORMS.includes(platform) || !platformId
      || typeof operationId !== 'string' || operationId.trim() === '') {
    res.status(400).json({ message: 'Vínculo manual inválido.' });
    return;
  }
  const db = getDb();
  const previous = db.manualLinkOps.find(o => o.userId === userId && o.operationId === operationId);
  if (previous) {
    const same = previous.contentId === contentId && previous.platform === platform && previous.platformId === platformId;
    if (!same) { res.status(422).json({ reason: 'operation_mismatch' }); return; }
    res.json({ ok: true, version: previous.resultVersion, deduplicated: true });
    return;
  }
  const target = db.files.find(f => f.userId === userId && f.contentId === contentId);
  if (!target) { res.status(404).json({ reason: 'not_found' }); return; }

  let video = db.platformVideos.find(v => v.userId === userId && v.platform === platform && v.platformId === platformId);
  const source = video?.linkedFileId
    ? db.files.find(f => f.userId === userId && f.id === video!.linkedFileId)
    : undefined;
  if (source && source.id !== target.id) {
    const sourceVersion = revisionDe(source, platform) + 1;
    source.platforms = source.platforms.filter(p => p !== platform);
    source.platformsDiscarded = source.platformsDiscarded.filter(p => p !== platform);
    source.platformRev = { ...(source.platformRev ?? {}), [platform]: sourceVersion };
  }
  const version = revisionDe(target, platform) + 1;
  if (!target.platforms.includes(platform)) target.platforms.push(platform);
  target.platformsDiscarded = target.platformsDiscarded.filter(p => p !== platform);
  target.platformRev = { ...(target.platformRev ?? {}), [platform]: version };
  if (!video) {
    video = {
      id: newId(), userId, platform, platformId,
      platformUrl: platformUrl ?? '', title: title ?? target.fileName, thumbnail: '',
      linkedFileId: target.id, views: 0, likes: 0, comments: 0,
      publishedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString(),
    };
    db.platformVideos.push(video);
  }
  video.linkedFileId = target.id;
  video.platformUrl = platformUrl ?? video.platformUrl;
  video.title = title ?? video.title;
  video.linkVersion = version;
  video.linkAuthority = 'manual';
  db.manualLinkOps.push({ userId, operationId, contentId, platform, platformId, resultVersion: version });
  persist();
  res.json({ ok: true, operationId, version, deduplicated: false });
};

// GET /api/sync/published-videos + POST -- "tarjetas de último publicado".
// Fuera del alcance recortado del Laboratorio (ver README): se responde un
// stub vacío/ok para que el cliente no rompa si igual las pide.
export const getPublishedCards = (_req: AuthRequest, res: Response): void => { res.json({ cards: [] }); };
export const mirrorPublishedCards = (_req: AuthRequest, res: Response): void => { res.json({ ok: true }); };
