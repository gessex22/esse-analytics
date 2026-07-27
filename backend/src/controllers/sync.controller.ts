import { Response } from 'express';
import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncYouTubeChannel, getYouTubeVideos, getRecentYouTubeVideosLive, getVideoStats as getYoutubeVideoStats } from '../services/youtube.service';
import { getRecentInstagramMedia, getMediaStats, PlatformRecentItem } from '../services/instagram.service';
import { getRecentTikTokVideos, getVideoStatsByIds as getTiktokVideoStats } from '../services/tiktok.service';
import { PlatformVideoModel, SyncPlatform } from '../models/platform-video.model';
import { FileModel } from '../models/file.model';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { applyPlatformPublish } from './backup.controller';

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

    // Confirmar el match acá solo tocaba PlatformVideoModel -- el badge (Videos),
    // el link del pull del PC, el Calendario y Nube nunca se enteraban de este
    // vínculo. Sin file_name no hay mucho que propagar (los otros stores
    // matchean por nombre), pero best-effort igual si el archivo no lo tiene.
    const linkedFile = await FileModel.findById(fileId).select('file_name').lean();
    if (linkedFile) {
      await applyPlatformPublish(userId, {
        platform: updated.platform, platformId: updated.platformId, platformUrl: updated.platformUrl,
        fileName: linkedFile.file_name,
        title: updated.title, publishedAt: updated.publishedAt, matchStatus: 'manual',
      });
    }

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

// DELETE /api/sync/platform-link/:fileId/:platform
// Quita la asociación central sin borrar el video publicado de la red. Esto
// evita que un link eliminado en Electron vuelva a aparecer al sincronizar.
export const unlinkPlatform = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { fileId, platform } = req.params;
    const userId = req.user!.id;
    if (!['youtube', 'instagram', 'tiktok', 'facebook'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' }); return;
    }
    const file = await FileModel.findOneAndUpdate(
      { _id: fileId, userId },
      { $pull: { platforms: platform, platforms_discarded: platform } },
      { new: true },
    ).select('_id');
    if (!file) { res.status(404).json({ message: 'Archivo no encontrado' }); return; }
    await PlatformVideoModel.updateMany(
      { userId, linkedFileId: file._id, platform },
      { $set: { linkedFileId: null, matchStatus: 'sin_match' } },
    );
    res.json({ ok: true, fileId, platform });
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

    // Igual que confirmLink: resolver un slot acá solo tocaba PlatformVideoModel
    // -- sin esto, un video recién matcheado desde Estadísticas/cross-match
    // podía tener el link ahí y en ningún otro lado (badge, Calendario, Nube).
    const linkedFile = await FileModel.findById(fileId).select('file_name').lean();
    if (linkedFile) {
      await applyPlatformPublish(userId, {
        platform, platformId, platformUrl,
        fileName: linkedFile.file_name,
        title, publishedAt: publishedAt ? new Date(publishedAt) : new Date(), matchStatus: 'manual',
      });
    }

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

// Dado los PlatformVideo (posiblemente con más de un documento por plataforma,
// ver applyPlatformPublish) linkeados a UN archivo, arma el objeto `platforms`
// quedándose con el mejor documento por plataforma y qué platformId de cada
// plataforma venció su ventana de cache y hay que refrescar en vivo.
// Compartido por getGroupStats (top-N completos) y getFileStats (un archivo
// puntual, sin exigir que esté en las 3 redes).
function buildFilePlatforms(pvs: {
  platform: string; platformId: string; platformUrl: string; title: string; thumbnail: string;
  views: number; likes: number; comments: number; publishedAt: Date; lastSyncedAt: Date;
}[]) {
  // Un mismo video de Instagram puede tener más de un documento (shortcode
  // del link pegado a mano vs. media id numérico real -- ver
  // applyPlatformPublish); el shortcode nunca tiene stats porque Graph API
  // no lo acepta para pedirlas. Ante un duplicado por plataforma se
  // prefiere el platformId numérico y, si empatan, el sincronizado más
  // reciente -- si no, cuál "gana" quedaba a merced del orden de Mongo.
  const bestByPlatform = new Map<string, (typeof pvs)[number]>();
  for (const pv of pvs) {
    const current = bestByPlatform.get(pv.platform);
    if (!current) { bestByPlatform.set(pv.platform, pv); continue; }
    if (pv.platform === 'instagram') {
      const currentNumeric = /^\d+$/.test(current.platformId);
      const candidateNumeric = /^\d+$/.test(pv.platformId);
      if (candidateNumeric && !currentNumeric) { bestByPlatform.set(pv.platform, pv); continue; }
      if (!candidateNumeric && currentNumeric) continue;
    }
    const currentSynced = current.lastSyncedAt ? new Date(current.lastSyncedAt).getTime() : 0;
    const candidateSynced = pv.lastSyncedAt ? new Date(pv.lastSyncedAt).getTime() : 0;
    if (candidateSynced > currentSynced) bestByPlatform.set(pv.platform, pv);
  }

  const platforms: Record<string, any> = {};
  const stale: Record<'youtube' | 'instagram' | 'tiktok', string | null> = { youtube: null, instagram: null, tiktok: null };
  for (const pv of bestByPlatform.values()) {
    platforms[pv.platform] = {
      platformId: pv.platformId, platformUrl: pv.platformUrl, title: pv.title, thumbnail: pv.thumbnail,
      views: pv.views ?? 0, likes: pv.likes ?? 0, comments: pv.comments ?? 0,
    };
    const lastSynced = pv.lastSyncedAt ? new Date(pv.lastSyncedAt).getTime() : 0;
    if (Date.now() - lastSynced > statsCacheWindowMs(pv.publishedAt)) {
      stale[pv.platform as 'youtube' | 'instagram' | 'tiktok'] = pv.platformId;
    }
  }
  return { platforms, stale };
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

    // Biblioteca remota es otra colección (storage en la nube), sin id en común
    // con FileModel — el único cruce posible hoy es por fileName. Ya viene
    // scopeado por userId, así que no hay ambigüedad ENTRE cuentas. Pero DENTRO
    // de la misma cuenta el nombre no es único (ej. nombres genéricos de cámara
    // repetidos): si el mismo fileName aparece más de una vez en el catálogo o
    // en Biblioteca remota, no hay forma de saber cuál es cuál — se deja sin
    // asignar (null) antes que arriesgar mostrar la miniatura equivocada.
    const fileNameCounts = new Map<string, number>();
    for (const f of files) {
      if (!f.file_name) continue;
      fileNameCounts.set(f.file_name, (fileNameCounts.get(f.file_name) ?? 0) + 1);
    }
    const fileNames = [...fileNameCounts.keys()];
    const remoteVideos = fileNames.length
      ? await RemoteLibraryVideoModel.find({ userId, fileName: { $in: fileNames } })
          .select('fileName thumbnailStoredFileName')
          .lean()
      : [];
    const remoteByFileName = new Map<string, { id: string; thumbnailStoredFileName: string | null }>();
    const remoteNameAmbiguous = new Set<string>();
    for (const rv of remoteVideos) {
      if (remoteByFileName.has(rv.fileName) || remoteNameAmbiguous.has(rv.fileName)) {
        remoteByFileName.delete(rv.fileName);
        remoteNameAmbiguous.add(rv.fileName);
      } else {
        remoteByFileName.set(rv.fileName, { id: String(rv._id), thumbnailStoredFileName: rv.thumbnailStoredFileName ?? null });
      }
    }

    const items: any[] = [];
    // Solo se piden en vivo los platformId que ya vencieron su ventana de
    // cache — el resto se sirve directo de lo guardado en Mongo.
    const toRefresh: Record<'youtube' | 'instagram' | 'tiktok', string[]> = { youtube: [], instagram: [], tiktok: [] };

    for (const f of files) {
      if (items.length >= limit) break;
      const pvs = byFile.get(String(f._id)) ?? [];
      // files.platforms también puede contener badges puestos manualmente sin
      // URL. Esos videos no tienen una identidad consultable ni métricas reales;
      // solo entran cuando las tres plataformas tienen PlatformVideoModel.
      const complete = ['youtube', 'instagram', 'tiktok'].every(platform =>
        pvs.some(pv => pv.platform === platform && !!pv.platformId)
      );
      if (!complete) continue;

      const { platforms, stale } = buildFilePlatforms(pvs);
      if (stale.youtube) toRefresh.youtube.push(stale.youtube);
      if (stale.instagram) toRefresh.instagram.push(stale.instagram);
      if (stale.tiktok) toRefresh.tiktok.push(stale.tiktok);
      // Si el nombre se repite entre los propios archivos del usuario, tampoco
      // se puede saber a cuál de ellos corresponde el match — mismo criterio
      // conservador que para duplicados del lado de Biblioteca remota.
      const nameIsUnique = fileNameCounts.get(f.file_name) === 1;
      const remoteMatch = nameIsUnique ? remoteByFileName.get(f.file_name) : undefined;
      items.push({
        fileId: String(f._id),
        fileName: f.file_name,
        remoteLibraryVideoId: remoteMatch?.id ?? null,
        thumbnailStoredFileName: remoteMatch?.thumbnailStoredFileName ?? null,
        fecha_creacion: f.fecha_creacion,
        platforms,
      });
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

// GET /api/sync/file-stats?fileId=&fileName= — stats en vivo de UN archivo
// puntual, sin exigir que ya esté publicado en las 3 plataformas (a diferencia
// de getGroupStats). La usa el Dashboard para el card de "último video
// publicado": ese video puede todavía no estar cross-posteado a las 3 redes,
// así que no puede depender de estar en el top-N "completo" de Estadísticas.
// Acepta fileId (el _id de Mongo que expone group-stats) o fileName -- en modo
// escritorio, el historial de subidas viene de SQLite local y su linkedFileId
// es un id local sin relación con Mongo, así que fileName es el único cruce
// posible ahí.
export const getFileStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const fileId = typeof req.query.fileId === 'string' ? req.query.fileId : undefined;
    const fileName = typeof req.query.fileName === 'string' ? req.query.fileName : undefined;
    if (!fileId && !fileName) { res.status(400).json({ message: 'fileId o fileName requerido.' }); return; }

    const file = fileId && Types.ObjectId.isValid(fileId)
      ? await FileModel.findOne({ _id: fileId, userId }).select('file_name fecha_creacion').lean()
      : fileName
        ? await FileModel.findOne({ userId, file_name: fileName }).select('file_name fecha_creacion').lean()
        : null;
    if (!file) { res.status(404).json({ message: 'No encontrado.' }); return; }

    const pvs = await PlatformVideoModel.find({
      userId, linkedFileId: file._id, platform: { $in: ['youtube', 'instagram', 'tiktok'] },
    })
      .select('platform platformId platformUrl title thumbnail views likes comments publishedAt lastSyncedAt')
      .lean();

    const { platforms, stale } = buildFilePlatforms(pvs);

    const [ytStats, igStats, tkStats] = await Promise.all([
      getYoutubeVideoStats(stale.youtube ? [stale.youtube] : []).catch(() => ({} as Record<string, any>)),
      getMediaStats(userId, stale.instagram ? [stale.instagram] : []).catch(() => ({} as Record<string, any>)),
      getTiktokVideoStats(userId, stale.tiktok ? [stale.tiktok] : []).catch(() => ({} as Record<string, any>)),
    ]);

    const bulkOps: any[] = [];
    for (const [platform, fresh] of [['youtube', ytStats], ['instagram', igStats], ['tiktok', tkStats]] as const) {
      const slot = platforms[platform];
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
    if (bulkOps.length > 0) PlatformVideoModel.bulkWrite(bulkOps).catch(() => {});

    res.json({
      fileId: String(file._id),
      fileName: file.file_name,
      fecha_creacion: file.fecha_creacion,
      platforms,
    });
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

const DEFAULT_INTERVAL_DAYS: Record<string, number> = { youtube: 4, instagram: 3, tiktok: 3 };

// Calcula "último publicado" a partir de PlatformVideoModel real (lo que suben
// syncYouTubeChannel, una subida real, o recordUploadEvent) -- independiente
// de que exista o no un override guardado en platform_config.
async function computeLastPublishedDynamic(
  userId: string,
  platform: string,
): Promise<{ lastPublishedTitle: string; lastPublishedDate: string; intervalDays: number } | null> {
  // Sin exigir linkedFileId -- el auto-sync de YouTube (syncYouTubeChannel)
  // trae los videos reales del canal ANTES de que alguien los cruce a mano
  // con su archivo local, así que los más recientes suelen llegar sin
  // linkedFileId todavía. Antes este filtro los excluía del todo, dejando
  // "último publicado" pegado en el último que SÍ estaba cruzado (días
  // atrás) en vez de en la publicación real más reciente.
  const videos = await PlatformVideoModel.find({ userId, platform: platform as SyncPlatform })
    .sort({ publishedAt: -1 })
    .limit(7)
    .lean();
  if (videos.length === 0) return null;

  const diffs: number[] = [];
  for (let i = 0; i < Math.min(6, videos.length - 1); i++) {
    const diff = Math.round(
      (new Date(videos[i].publishedAt).getTime() - new Date(videos[i + 1].publishedAt).getTime())
      / (1000 * 60 * 60 * 24)
    );
    diffs.push(diff);
  }
  const intervalDays = diffs.length
    ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length)
    : DEFAULT_INTERVAL_DAYS[platform];

  const linkedFile = videos[0].linkedFileId
    ? await FileModel.findById(videos[0].linkedFileId).select('file_name').lean()
    : null;
  return {
    lastPublishedTitle: linkedFile?.file_name ?? videos[0].title,
    lastPublishedDate:  new Date(videos[0].publishedAt).toISOString().slice(0, 10),
    intervalDays,
  };
}

// GET /api/sync/calendar-config — configuración real del calendario por plataforma
export const getCalendarConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const db = (await import('mongoose')).default.connection.db!;
    const userId = req.user!.id;   // calendario por cuenta (no compartido entre usuarios)

    // platform_config tiene overrides que solo avanzan por caminos puntuales
    // (subir desde el escritorio, el botón "Fijar", o recordUploadEvent tras
    // publicar desde el celular) -- CUALQUIER otra vía que marque un video
    // como publicado (el auto-sync de YouTube, publicar directo desde
    // Biblioteca remota, vincular a mano en Sincronizar) nunca los toca, y el
    // override se queda pegado mostrando un "último publicado" viejo aunque
    // haya algo más reciente de verdad. Por eso NINGUNA plataforma confía
    // ciegamente en el override: siempre se calcula también la versión real
    // (PlatformVideoModel, la fuente que sí actualizan todos esos caminos) y
    // se usa la que tenga la fecha más reciente de las dos.
    const stored = await db.collection('platform_config')
      .find({ userId, platform: { $in: ['tiktok', 'instagram', 'youtube'] } })
      .toArray();

    const storedMap = new Map(stored.map(c => [c.platform as string, c]));

    const allConfigs = await Promise.all(['youtube', 'tiktok', 'instagram'].map(async (platform) => {
      const override = storedMap.get(platform);
      const dynamic = await computeLastPublishedDynamic(userId, platform);

      const overrideDate = override?.lastPublishedDate ? new Date(override.lastPublishedDate).getTime() : 0;
      const dynamicDate = dynamic?.lastPublishedDate ? new Date(dynamic.lastPublishedDate).getTime() : 0;
      // Empate (mismo día) a favor del override -- suele traer el intervalDays
      // que el usuario ajustó a mano, que la versión dinámica no puede saber.
      const useDynamic = dynamic && dynamicDate > overrideDate;

      const base = useDynamic
        ? dynamic!
        : override
          ? { lastPublishedTitle: override.lastPublishedTitle, lastPublishedDate: override.lastPublishedDate, intervalDays: override.intervalDays ?? dynamic?.intervalDays ?? DEFAULT_INTERVAL_DAYS[platform] }
          : dynamic ?? { lastPublishedTitle: '', lastPublishedDate: '', intervalDays: DEFAULT_INTERVAL_DAYS[platform] };

      return {
        platform,
        ...base,
        lastVideoId: override?.lastVideoId ?? null,
        nextVideoId: override?.nextVideoId ?? null,
        nextRemoteLibraryVideoId: override?.nextRemoteLibraryVideoId ?? null,
      };
    }));

    // Enriquece con datos del nextVideo para cada plataforma. El puntero guardado
    // (nextVideoId) solo avanza vía "Subir" o el botón "Fijar" del calendario —
    // marcar la plataforma resuelta por otro camino (toggle en Videos, "Editar
    // links") no lo toca. Si el archivo al que apunta ya está resuelto para ESA
    // plataforma (publicado o descartado), el puntero quedó obsoleto: se
    // descarta y se recalcula el verdadero próximo (el más reciente sin
    // resolver ahí), igual que hace fileRepo.findNextUnpublished en local.
    const enriched = await Promise.all(allConfigs.map(async (cfg) => {
      const platform = cfg.platform;
      let file: any = null;
      let resolvedId: string | null = null; // a qué archivo apuntaba el puntero guardado, antes de chequear si quedó obsoleto

      if (cfg.nextVideoId) {
        try {
          const mongoose = (await import('mongoose')).default;
          try {
            file = await FileModel.findById(new mongoose.Types.ObjectId(String(cfg.nextVideoId)))
              .select('file_name content_id duracion_segundos platforms platforms_discarded').lean();
          } catch { /* nextVideoId no es un ObjectId válido — buscar por file_name */ }
          if (!file) {
            file = await FileModel.findOne({ file_name: String(cfg.nextVideoId), userId })
              .select('file_name content_id duracion_segundos platforms platforms_discarded').lean();
          }
          if (file) {
            resolvedId = String((file as any)._id);
            if ((file.platforms ?? []).includes(platform) || (file.platforms_discarded ?? []).includes(platform)) {
              file = null; // obsoleto — cae al recálculo de abajo
            }
          }
        } catch { file = null; }
      }

      if (!file) {
        file = await FileModel.findOne({
          userId,
          status: { $ne: 'ELIMINADO_DISCO' },
          content_status: { $ne: 'descartado' },
          platforms: { $ne: platform },
          platforms_discarded: { $ne: platform },
        }).sort({ fecha_creacion: -1, _id: -1 }).select('file_name content_id duracion_segundos').lean();
      }

      // Esta autocorrección antes solo vivía en memoria (se devolvía bien en
      // la respuesta pero platform_config quedaba con el puntero viejo para
      // siempre). Sin persistirla, ensurePreloadForNextVideos (desktop) sigue
      // viendo el nextRemoteLibraryVideoId huérfano de la vez anterior y nunca
      // vuelve a precargar el archivo realmente próximo -- mismo bug que en
      // syncCalendarAfterPublish, este es el otro camino por el que "próximo"
      // podía cambiar sin invalidar la precarga.
      const finalId = file ? String((file as any)._id) : null;
      if (finalId !== resolvedId) {
        const mongooseMod = (await import('mongoose')).default;
        mongooseMod.connection.db!.collection('platform_config').updateOne(
          { userId, platform },
          { $set: { nextVideoId: file ? (file as any).file_name : null, nextRemoteLibraryVideoId: null } },
        ).catch(() => {});
      }

      if (!file) return { ...cfg, nextVideoId: null, nextVideo: null };
      const dur = (file as any).duracion_segundos as number | undefined;
      const duration = dur
        ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`
        : '';
      return {
        ...cfg,
        nextVideoId: String(file._id),
        nextVideo: {
          fileId: String(file._id),
          contentId: (file as any).content_id ?? null,
          title: (file as any).file_name,
          duration,
        },
      };
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
    const { lastPublishedDate, lastPublishedTitle, intervalDays, lastVideoId, nextVideoId, nextRemoteLibraryVideoId } = req.body;
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
    // Id real de RemoteLibraryVideoModel para "el próximo" -- lo manda el
    // cliente (local-backend, ver calendar-sync.service.ts) DESPUÉS de
    // confirmar/subir el video a Biblioteca remota. Reemplaza el cruce por
    // fileName (ambiguo si hay nombres repetidos) como fuente de verdad para
    // el almacenamiento dinámico (ver remote-library-retention.service.ts).
    if (nextRemoteLibraryVideoId !== undefined) fields.nextRemoteLibraryVideoId = nextRemoteLibraryVideoId;

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
