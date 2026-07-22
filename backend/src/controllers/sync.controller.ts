import { Response } from 'express';
import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncYouTubeChannel, getYouTubeVideos, getRecentYouTubeVideosLive, getVideoStats as getYoutubeVideoStats } from '../services/youtube.service';
import { getRecentInstagramMedia, getMediaStats, PlatformRecentItem } from '../services/instagram.service';
import { getRecentTikTokVideos, getVideoStatsByIds as getTiktokVideoStats } from '../services/tiktok.service';
import { PlatformVideoModel, SyncPlatform } from '../models/platform-video.model';
import { FileModel } from '../models/file.model';

export const triggerYouTubeSync = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await syncYouTubeChannel(req.user!.id);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

export const getYouTubeList = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const data  = await getYouTubeVideos(req.user!.id, page, limit);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

export const getSyncStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const youtube   = await PlatformVideoModel.countDocuments({ userId, platform: 'youtube' });
    const instagram = await PlatformVideoModel.countDocuments({ userId, platform: 'instagram' });
    const tiktok    = await PlatformVideoModel.countDocuments({ userId, platform: 'tiktok' });
    const linked    = await PlatformVideoModel.countDocuments({ userId, linkedFileId: { $ne: null } });
    const revisar   = await PlatformVideoModel.countDocuments({ userId, matchStatus: 'revisar_manual' });
    const sinMatch  = await PlatformVideoModel.countDocuments({ userId, matchStatus: 'sin_match' });
    res.json({ youtube, instagram, tiktok, linked, revisar, sinMatch });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/review — lista de videos YT pendientes de revisión manual con sus candidatos
export const getReviewList = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip  = (page - 1) * limit;

    const total = await PlatformVideoModel.countDocuments({ userId, matchStatus: 'revisar_manual' });
    const items = await PlatformVideoModel.find({ userId, matchStatus: 'revisar_manual' })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Poblar candidatos: matchCandidates guarda IDs como strings
    const enriched = await Promise.all(items.map(async (pv) => {
      const candidateIds = (pv.matchCandidates ?? []).map((id: string) => {
        try { return new Types.ObjectId(id); } catch { return null; }
      }).filter(Boolean);

      const candidates = candidateIds.length
        ? await FileModel.find({ _id: { $in: candidateIds }, userId })
            .select('file_name duracion_segundos fecha_creacion formato')
            .lean()
        : [];

      return { ...pv, candidates };
    }));

    res.json({ total, page, totalPages: Math.ceil(total / limit), items: enriched });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/review/:pvId/link — confirma un match manual
export const confirmLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { pvId } = req.params;
    const { fileId } = req.body;
    const userId = req.user!.id;
    if (!fileId) { res.status(400).json({ message: 'fileId requerido' }); return; }

    const updated = await PlatformVideoModel.findOneAndUpdate({ _id: pvId, userId }, {
      linkedFileId: new Types.ObjectId(fileId),
      matchStatus: 'manual',
      $unset: { matchCandidates: '' },
    });
    if (!updated) { res.status(404).json({ message: 'No encontrado.' }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/review/:pvId/orphan — marca como huérfano
export const markOrphan = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { pvId } = req.params;
    const userId = req.user!.id;
    const updated = await PlatformVideoModel.findOneAndUpdate({ _id: pvId, userId }, {
      matchStatus: 'sin_match',
      $unset: { matchCandidates: '' },
    });
    if (!updated) { res.status(404).json({ message: 'No encontrado.' }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/platform-recent/:platform?limit=20&cursor=... — página de videos
// EN VIVO de la plataforma, para elegir manualmente cuáles son "el mismo video"
// entre redes (emparejado cruzado). `cursor` es lo que devolvió la página
// anterior en `nextCursor` — hace falta paginar de verdad (no solo traer un lote
// fijo) porque cada plataforma publica a un ritmo distinto: si TikTok publica
// mucho más seguido que YouTube/Instagram, sus últimos 20 pueden cubrir apenas
// unos días mientras las otras cubren meses, y nunca se llega a la misma fecha
// sin poder seguir retrocediendo. Excluye los que ya quedaron agrupados antes.
export const getPlatformRecent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { platform } = req.params as { platform: SyncPlatform };
    const limit  = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const userId = req.user!.id;

    if (!['youtube', 'instagram', 'tiktok'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' });
      return;
    }

    let items: PlatformRecentItem[];
    let nextCursor: string | null;
    if (platform === 'youtube') {
      // En vivo directo del canal — no depende de que "Re-sincronizar" se haya
      // corrido antes (ver getRecentYouTubeVideosLive).
      const yt = await getRecentYouTubeVideosLive(limit, cursor);
      items = yt.items;
      nextCursor = yt.nextCursor;
    } else if (platform === 'instagram') {
      const page = await getRecentInstagramMedia(userId, limit, cursor);
      items = page.items;
      nextCursor = page.nextCursor;
    } else {
      const page = await getRecentTikTokVideos(userId, limit, cursor);
      items = page.items;
      nextCursor = page.nextCursor;
    }

    // Filtra los que ya quedaron agrupados en un match cruzado previo.
    const already = await PlatformVideoModel.find({
      userId, platform, platformId: { $in: items.map(i => i.platformId) },
      crossMatchGroupId: { $ne: null },
    }).select('platformId').lean();
    const excluded = new Set(already.map(d => d.platformId));

    res.json({ items: items.filter(i => !excluded.has(i.platformId)), nextCursor });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/cross-match — confirma que 2 o 3 videos (uno por plataforma) son
// el mismo contenido publicado en varias redes. NO toca linkedFileId/matchStatus:
// ese vínculo con el archivo local es independiente de este agrupamiento.
export const confirmCrossMatch = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const items = (req.body?.items ?? []) as Array<{
      platform: SyncPlatform; platformId: string; title?: string; thumbnail?: string;
      publishedAt?: string; platformUrl?: string | null;
    }>;

    if (!Array.isArray(items) || items.length < 2) {
      res.status(400).json({ message: 'Se necesitan al menos 2 videos para emparejar.' });
      return;
    }
    const platforms = new Set(items.map(i => i.platform));
    if (platforms.size !== items.length) {
      res.status(400).json({ message: 'No se puede emparejar dos videos de la misma plataforma.' });
      return;
    }

    // Si alguno ya pertenece a un grupo, se reutiliza ese id — así uniones
    // sucesivas terminan en el mismo grupo en vez de fragmentarse en varios.
    const existing = await PlatformVideoModel.find({
      userId,
      $or: items.map(i => ({ platform: i.platform, platformId: i.platformId })),
    }).lean();
    const groupId = existing.find(e => e.crossMatchGroupId)?.crossMatchGroupId ?? randomUUID();

    for (const item of items) {
      await PlatformVideoModel.findOneAndUpdate(
        { userId, platform: item.platform, platformId: item.platformId },
        {
          $set: {
            userId,
            platform:          item.platform,
            platformId:        item.platformId,
            platformUrl:       item.platformUrl ?? '',
            title:             item.title ?? '',
            publishedAt:       item.publishedAt ? new Date(item.publishedAt) : new Date(),
            thumbnail:         item.thumbnail ?? '',
            crossMatchGroupId: groupId,
            lastSyncedAt:      new Date(),
          },
        },
        { upsert: true }
      );
    }

    res.json({ ok: true, groupId });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/cross-match/candidates?limit=20&page=1 — en vez de adivinar a
// ciegas con las 3 ruedas por separado, arranca de lo que YA se sabe local: los
// archivos que tienen las 3 badges de plataforma marcadas (files.platforms).
// Por cada uno, resuelve qué plataformas ya tienen un platform_video vinculado
// (linkedFileId) y cuáles todavía faltan — así el usuario solo busca lo que
// realmente falta, no todo desde cero.
export const getCrossMatchCandidates = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const limit  = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const page   = Math.max(1, parseInt(req.query.page as string) || 1);

    const query = { userId, platforms: { $all: ['youtube', 'instagram', 'tiktok'] } };
    const [total, files] = await Promise.all([
      FileModel.countDocuments(query),
      FileModel.find(query)
        .sort({ fecha_creacion: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('file_name fecha_creacion duracion_segundos')
        .lean(),
    ]);

    const fileIds = files.map(f => f._id);
    const linked = await PlatformVideoModel.find({ userId, linkedFileId: { $in: fileIds } })
      .select('linkedFileId platform platformId platformUrl title thumbnail')
      .lean();
    const byFile = new Map<string, typeof linked>();
    for (const pv of linked) {
      const key = String(pv.linkedFileId);
      byFile.set(key, [...(byFile.get(key) ?? []), pv]);
    }

    const candidates = files.map(f => {
      const resolvedFor = byFile.get(String(f._id)) ?? [];
      const resolved: Record<string, any> = { youtube: null, instagram: null, tiktok: null };
      for (const pv of resolvedFor) {
        resolved[pv.platform] = {
          platformId: pv.platformId, platformUrl: pv.platformUrl,
          title: pv.title, thumbnail: pv.thumbnail,
        };
      }
      return {
        fileId:   String(f._id),
        fileName: f.file_name,
        fecha_creacion: f.fecha_creacion,
        resolved,
      };
    });

    res.json({ items: candidates, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/cross-match/resolve — confirma que un video de una plataforma
// específica corresponde a un archivo local puntual (ya sabido de antemano por
// tener las 3 badges). A diferencia de confirmCrossMatch, acá SÍ fija
// linkedFileId — es exactamente la misma acción que "Vincular con archivo local"
// (confirmLink), solo que el candidato puede venir de un fetch en vivo (IG/TikTok)
// que todavía no tiene un doc propio en Mongo, por eso hace upsert.
export const resolveCrossMatchSlot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { fileId, platform, platformId, title, thumbnail, publishedAt, platformUrl, stats } = req.body ?? {};

    if (!fileId || !platform || !platformId) {
      res.status(400).json({ message: 'fileId, platform y platformId son requeridos.' });
      return;
    }
    if (!['youtube', 'instagram', 'tiktok'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' });
      return;
    }

    // Los nombres de campo de stats no son uniformes entre plataformas
    // (ver instagram.service.ts / tiktok.service.ts) — se normalizan acá para
    // que la vista de Estadísticas los pueda leer siempre igual.
    const s = stats ?? {};
    const views    = s.views    ?? 0;
    const likes    = s.likes    ?? s.like_count     ?? 0;
    const comments = s.comments ?? s.comments_count ?? 0;

    // Re-matchear (ej. un link que quedó apuntando a un video borrado/privado)
    // dejaba el doc VIEJO todavía linkeado a este archivo, con otro platformId
    // — group-stats terminaba con 2 registros "youtube" para el mismo archivo
    // compitiendo por el mismo slot, y cuál ganaba dependía del orden en que
    // Mongo los devolviera (el bug de "a veces sí, a veces no"). Se desvincula
    // cualquier otro doc de esta plataforma que ya apuntara acá antes de crear
    // el nuevo link, para que quede uno solo.
    await PlatformVideoModel.updateMany(
      { userId, platform, linkedFileId: new Types.ObjectId(fileId), platformId: { $ne: platformId } },
      { $set: { linkedFileId: null, matchStatus: 'sin_match' } },
    );

    await PlatformVideoModel.findOneAndUpdate(
      { userId, platform, platformId },
      {
        $set: {
          userId, platform, platformId,
          platformUrl:  platformUrl ?? '',
          title:        title ?? '',
          thumbnail:    thumbnail ?? '',
          publishedAt:  publishedAt ? new Date(publishedAt) : new Date(),
          linkedFileId: new Types.ObjectId(fileId),
          matchStatus:  'manual',
          views, likes, comments,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// Cuánto tiempo se banca un valor guardado antes de pedirlo de nuevo en vivo —
// un video recién publicado se mueve rápido (vale la pena refrescar seguido),
// uno viejo ya está en plateau (refrescarlo todo el tiempo es gastar cuota de
// las APIs para no ver casi ningún cambio).
function statsCacheWindowMs(publishedAt?: Date | string | null): number {
  if (!publishedAt) return 60 * 60 * 1000; // sin fecha conocida → cada hora
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86_400_000;
  if (ageDays < 2) return 5 * 60 * 1000;   // < 2 días: cada 5 min
  return 60 * 60 * 1000;                    // 2+ días: cada hora
}

// GET /api/sync/group-stats?limit=5 — para la vista de Estadísticas: los últimos
// N videos que YA están matcheados en las 3 plataformas, con las stats de cada
// una para compararlas lado a lado. Es la misma vista para modo simple y
// avanzado (no depende de workflow_mode) — el matching es siempre por archivo.
export const getGroupStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const limit  = Math.min(parseInt(req.query.limit as string) || 5, 20);

    const files = await FileModel.find({ userId, platforms: { $all: ['youtube', 'instagram', 'tiktok'] } })
      .sort({ fecha_creacion: -1 })
      .select('file_name fecha_creacion')
      .lean();

    const fileIds = files.map(f => f._id);
    // La vista compara solo las 3 redes con stats propias — los registros de
    // 'facebook' (crossposting) quedan afuera para no inflar el conteo de "3
    // plataformas vinculadas" ni pedir stats que Facebook no expone acá.
    const linked = await PlatformVideoModel.find({
      userId, linkedFileId: { $in: fileIds }, platform: { $in: ['youtube', 'instagram', 'tiktok'] },
    })
      .select('linkedFileId platform platformId platformUrl title thumbnail views likes comments publishedAt lastSyncedAt')
      .lean();
    const byFile = new Map<string, typeof linked>();
    for (const pv of linked) {
      const key = String(pv.linkedFileId);
      byFile.set(key, [...(byFile.get(key) ?? []), pv]);
    }

    const items: any[] = [];
    // Solo se piden en vivo los platformId que ya vencieron su ventana de
    // cache — el resto se sirve directo de lo guardado en Mongo.
    const toRefresh: Record<'youtube' | 'instagram' | 'tiktok', string[]> = { youtube: [], instagram: [], tiktok: [] };

    for (const f of files) {
      if (items.length >= limit) break;
      const pvs = byFile.get(String(f._id)) ?? [];
      if (pvs.length < 3) continue; // solo videos con las 3 plataformas YA vinculadas

      const platforms: Record<string, any> = {};
      for (const pv of pvs) {
        platforms[pv.platform] = {
          platformId: pv.platformId, platformUrl: pv.platformUrl, title: pv.title, thumbnail: pv.thumbnail,
          views: pv.views ?? 0, likes: pv.likes ?? 0, comments: pv.comments ?? 0,
        };
        const lastSynced = pv.lastSyncedAt ? new Date(pv.lastSyncedAt).getTime() : 0;
        const stale = Date.now() - lastSynced > statsCacheWindowMs(pv.publishedAt);
        if (stale) toRefresh[pv.platform as 'youtube' | 'instagram' | 'tiktok'].push(pv.platformId);
      }
      items.push({ fileId: String(f._id), fileName: f.file_name, fecha_creacion: f.fecha_creacion, platforms });
    }

    // Refresco en vivo — acotado por la ventana de cache de arriba y, en el
    // peor caso (todo vencido), a como mucho `limit` videos × 3 plataformas.
    const [ytStats, igStats, tkStats] = await Promise.all([
      getYoutubeVideoStats(toRefresh.youtube).catch(() => ({} as Record<string, any>)),
      getMediaStats(userId, toRefresh.instagram).catch(() => ({} as Record<string, any>)),
      getTiktokVideoStats(userId, toRefresh.tiktok).catch(() => ({} as Record<string, any>)),
    ]);

    const bulkOps: any[] = [];
    for (const item of items) {
      for (const [platform, fresh] of [['youtube', ytStats], ['instagram', igStats], ['tiktok', tkStats]] as const) {
        const slot = item.platforms[platform];
        const update = slot && fresh[slot.platformId];
        if (!update) continue;
        Object.assign(slot, update);
        bulkOps.push({
          updateOne: {
            filter: { userId, platform, platformId: slot.platformId },
            update: { $set: { views: update.views ?? 0, likes: update.likes ?? 0, comments: update.comments ?? 0, lastSyncedAt: new Date() } },
          },
        });
      }
    }
    if (bulkOps.length > 0) PlatformVideoModel.bulkWrite(bulkOps).catch(() => {});

    res.json({ items });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/stats-by-ids — stats en vivo para un set de platformId sueltos,
// sin pasar por PlatformVideoModel/cross-match. Lo usa local-backend para armar
// Estadísticas de instalaciones que solo tienen el catálogo en SQLite local (no
// respaldado en la nube): arma los ids desde platform_videos local y pide acá
// las stats reales, usando igual los tokens OAuth que viven en esta central.
export const getStatsByIds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};
    const clamp = (arr: unknown): string[] => (Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []).slice(0, 60);
    const youtube   = clamp(body.youtube);
    const instagram = clamp(body.instagram);
    const tiktok    = clamp(body.tiktok);

    const [ytStats, igStats, tkStats] = await Promise.all([
      getYoutubeVideoStats(youtube).catch(() => ({} as Record<string, any>)),
      getMediaStats(userId, instagram).catch(() => ({} as Record<string, any>)),
      getTiktokVideoStats(userId, tiktok).catch(() => ({} as Record<string, any>)),
    ]);

    res.json({ youtube: ytStats, instagram: igStats, tiktok: tkStats });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/calendar-config — configuración real del calendario por plataforma
export const getCalendarConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const db = (await import('mongoose')).default.connection.db!;
    const userId = req.user!.id;   // calendario por cuenta (no compartido entre usuarios)

    // platform_config tiene overrides manuales para cualquier plataforma
    const stored = await db.collection('platform_config')
      .find({ userId, platform: { $in: ['tiktok', 'instagram', 'youtube'] } })
      .toArray();

    const storedMap = new Map(stored.map(c => [c.platform as string, c]));

    // YouTube: usa override manual si existe, si no calcula desde platformvideos
    let ytConfig: { platform: string; lastPublishedTitle: string; lastPublishedDate: string; intervalDays: number };
    const ytOverride = storedMap.get('youtube');
    if (ytOverride) {
      ytConfig = {
        platform:           'youtube',
        lastPublishedTitle: ytOverride.lastPublishedTitle,
        lastPublishedDate:  ytOverride.lastPublishedDate,
        intervalDays:       ytOverride.intervalDays ?? 4,
      };
    } else {
      const ytVideos = await PlatformVideoModel.find({ userId, platform: 'youtube', linkedFileId: { $ne: null } })
        .sort({ publishedAt: -1 })
        .limit(7)
        .lean();

      ytConfig = { platform: 'youtube', lastPublishedTitle: '', lastPublishedDate: '', intervalDays: 4 };
      if (ytVideos.length > 0) {
        const diffs: number[] = [];
        for (let i = 0; i < Math.min(6, ytVideos.length - 1); i++) {
          const diff = Math.round(
            (new Date(ytVideos[i].publishedAt).getTime() - new Date(ytVideos[i + 1].publishedAt).getTime())
            / (1000 * 60 * 60 * 24)
          );
          diffs.push(diff);
        }
        const interval = diffs.length
          ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length)
          : 4;

        const linkedFile = await FileModel.findById(ytVideos[0].linkedFileId).select('file_name').lean();
        ytConfig = {
          platform:           'youtube',
          lastPublishedTitle: linkedFile?.file_name ?? ytVideos[0].title,
          lastPublishedDate:  new Date(ytVideos[0].publishedAt).toISOString().slice(0, 10),
          intervalDays:       interval,
        };
      }
    }

    const result = ['tiktok', 'instagram'].map(p => {
      const c = storedMap.get(p);
      return c
        ? { platform: p, lastPublishedTitle: c.lastPublishedTitle, lastPublishedDate: c.lastPublishedDate, intervalDays: c.intervalDays ?? 3, lastVideoId: c.lastVideoId ?? null, nextVideoId: c.nextVideoId ?? null }
        : { platform: p, lastPublishedTitle: '', lastPublishedDate: '', intervalDays: 3, lastVideoId: null, nextVideoId: null };
    });

    const allConfigs = [{ ...ytConfig, lastVideoId: ytOverride?.lastVideoId ?? null, nextVideoId: ytOverride?.nextVideoId ?? null }, ...result];

    // Enriquece con datos del nextVideo para cada plataforma
    const enriched = await Promise.all(allConfigs.map(async (cfg) => {
      if (!cfg.nextVideoId) return { ...cfg, nextVideo: null };
      try {
        const mongoose = (await import('mongoose')).default;
        let file: any = null;
        try {
          file = await FileModel.findById(new mongoose.Types.ObjectId(String(cfg.nextVideoId)))
            .select('file_name duracion_segundos').lean();
        } catch { /* nextVideoId no es un ObjectId válido — buscar por file_name */ }
        if (!file) {
          file = await FileModel.findOne({ file_name: String(cfg.nextVideoId), userId })
            .select('file_name duracion_segundos').lean();
        }
        if (!file) return { ...cfg, nextVideo: null };
        const dur = (file as any).duracion_segundos as number | undefined;
        const duration = dur
          ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`
          : '';
        return { ...cfg, nextVideo: { fileId: String(file._id), title: (file as any).file_name, duration } };
      } catch {
        return { ...cfg, nextVideo: null };
      }
    }));

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/sync/calendar-config/:platform — fija el último video publicado en cualquier plataforma
export const updateCalendarConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { platform } = req.params;
    const { lastPublishedDate, lastPublishedTitle, intervalDays, lastVideoId, nextVideoId } = req.body;
    if (!['tiktok', 'instagram', 'youtube'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' });
      return;
    }
    const fields: Record<string, unknown> = {};
    if (lastPublishedDate  !== undefined) fields.lastPublishedDate  = lastPublishedDate;
    if (lastPublishedTitle !== undefined) fields.lastPublishedTitle = lastPublishedTitle;
    if (intervalDays       !== undefined) fields.intervalDays       = intervalDays;
    if (lastVideoId        !== undefined) fields.lastVideoId        = lastVideoId;
    if (nextVideoId        !== undefined) fields.nextVideoId        = nextVideoId;

    const userId = req.user!.id;
    fields.userId = userId;
    const db = (await import('mongoose')).default.connection.db!;
    await db.collection('platform_config').updateOne(
      { userId, platform },
      { $set: fields },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/record-publish — un cliente que publica DIRECTO a la plataforma
// (iOS/Android, sin pasar por youtube/instagram/tiktok-upload.controller.ts de
// acá) no deja ningún rastro en FileModel/PlatformVideoModel, así que
// getGroupStats (Estadísticas) nunca tiene de dónde sacar el platformId real y
// el usuario tenía que ir a pegar el link a mano en Videos (escritorio). Esto
// cierra ese hueco: upsert de ambas colecciones con lo que el cliente YA sabe
// apenas termina de publicar, sin ningún paso manual.
// matchStatus 'remote' (ver platform-video.model.ts) distingue este origen del
// resto (auto_text/auto_duration = matching por sync, manual = el usuario lo
// vinculó a mano en la vista de revisión).
export const recordPublish = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { fileName, platform, platformId, platformUrl, title, publishedAt } = req.body as {
      fileName?: string; platform?: SyncPlatform; platformId?: string; platformUrl?: string;
      title?: string; publishedAt?: string;
    };
    if (!fileName || !platform || !platformId || !platformUrl) {
      res.status(400).json({ message: 'fileName, platform, platformId y platformUrl son requeridos' });
      return;
    }

    const file = await FileModel.findOneAndUpdate(
      { userId, file_name: fileName },
      { $setOnInsert: { userId, file_name: fileName, file_path: fileName, status: 'PENDIENTE' } },
      { upsert: true, new: true },
    );
    if (platform !== 'facebook') {
      await FileModel.updateOne({ _id: file._id }, { $addToSet: { platforms: platform } });
    }

    await PlatformVideoModel.findOneAndUpdate(
      { userId, platform, platformId },
      {
        $set: {
          platformUrl,
          title: title ?? '',
          publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
          linkedFileId: file._id,
          matchStatus: 'remote',
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true },
    );

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};
