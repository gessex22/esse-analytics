import { Response } from 'express';
import { getDb, persist } from '../store/db';
import { AuthRequest } from '../middleware/auth.middleware';
import { Platform } from '../store/types';
import { applyPlatformPublish } from './publish.service';

const PLATFORMS: Platform[] = ['youtube', 'instagram', 'tiktok'];
const DEFAULT_INTERVAL: Record<Platform, number> = { youtube: 4, instagram: 3, tiktok: 3 };

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

// GET /api/sync/published-videos + POST -- "tarjetas de último publicado".
// Fuera del alcance recortado del Laboratorio (ver README): se responde un
// stub vacío/ok para que el cliente no rompa si igual las pide.
export const getPublishedCards = (_req: AuthRequest, res: Response): void => { res.json({ cards: [] }); };
export const mirrorPublishedCards = (_req: AuthRequest, res: Response): void => { res.json({ ok: true }); };
