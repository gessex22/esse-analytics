import { Request, Response } from 'express';
import { fileRepo } from '../db/file.repo';
import { platformVideoRepo } from '../db/platform-video.repo';
import { configRepo } from '../db/config.repo';
import { AuthRequest } from '../middleware/auth.middleware';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// Intervalo por defecto por plataforma cuando no hay nada configurado.
const DEFAULT_INTERVAL: Record<string, number> = { youtube: 4, tiktok: 3, instagram: 3 };

function fmtDuration(secs?: number): string {
  if (!secs) return '';
  return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
}

// Resuelve un next_video_id guardado (puede ser un id numérico o un file_name) al
// archivo local. Datos viejos guardaban el TÍTULO; los nuevos guardan el id.
function resolveStoredVideo(stored: unknown) {
  if (stored == null || stored === '') return undefined;
  const s = String(stored);
  return (/^\d+$/.test(s) ? fileRepo.findById(s) : undefined) ?? fileRepo.findByName(s);
}

// GET /api/sync/calendar-config
// El "próximo video" es por plataforma y se RESPETA el guardado en platform_config
// (lo setea publicar y el botón "Fijar"). Solo si no hay nada guardado se computa un
// fallback razonable (el más reciente sin publicar). Última publicación e intervalo
// también salen de platform_config. Cada plataforma avanza independiente.
export const getCalendarConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const storedMap = new Map(configRepo.getAllPlatformConfigs().map(c => [c.platform as string, c]));
    const platforms = ['youtube', 'tiktok', 'instagram'] as const;

    const enriched = platforms.map((p) => {
      const c = storedMap.get(p);
      const next = resolveStoredVideo(c?.next_video_id) ?? fileRepo.findNextUnpublished(p);
      return {
        platform:           p,
        lastPublishedTitle: (c?.last_published_title as string) ?? '',
        lastPublishedDate:  (c?.last_published_date  as string) ?? '',
        intervalDays:       (c?.interval_days as number) ?? DEFAULT_INTERVAL[p],
        lastVideoId:        c?.last_video_id ?? null,
        nextVideoId:        next ? String(next.id) : null,
        nextVideo:          next
          ? { fileId: String(next.id), title: next.file_name, duration: fmtDuration(next.duracion_segundos) }
          : null,
      };
    });

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/published-videos
// Para cada plataforma: el último video publicado (platform_videos) + nombre del archivo local
export const getPublishedVideos = (_req: Request, res: Response): void => {
  try {
    const platforms = ['youtube', 'tiktok', 'instagram'] as const;
    const result = platforms.map((platform) => {
      const latestPv   = platformVideoRepo.findLatestWithFileName(platform);
      const latestFile = fileRepo.findLatestPublished(platform);

      // El archivo más nuevo con el badge de esta plataforma puede no ser el mismo
      // que el último platform_video conocido: esa tabla se vacía en cada wipe de
      // logout y solo se repuebla parcial (backup_platform_videos es un espejo más
      // flaco que files.platforms). Si no coinciden, se prefiere el archivo real
      // -- aunque falte el platformId/url exacto, mostrar el video físico correcto
      // sin ese dato es mejor que mostrar uno viejo con el dato completo.
      if (latestFile && (!latestPv || latestPv.linked_file_id !== latestFile.id)) {
        return {
          platform,
          fileId:      String(latestFile.id),
          fileName:    latestFile.file_name,
          platformId:  null,
          platformUrl: null,
          publishedAt: latestFile.fecha_creacion ?? latestFile.updated_at,
        };
      }

      if (!latestPv) {
        return { platform, fileId: null, fileName: null, platformId: null, platformUrl: null, publishedAt: null };
      }
      return {
        platform,
        fileId:      latestPv.linked_file_id ? String(latestPv.linked_file_id) : null,
        fileName:    latestPv.file_name ?? null,
        platformId:  latestPv.platform_id,
        platformUrl: latestPv.platform_url ?? null,
        publishedAt: latestPv.published_at ?? null,
      };
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/history?limit=&offset=&platform=
// Registro cronológico de todas las subidas hechas desde la app (platform_videos
// se llena solo en cada upload: youtube/tiktok/instagram/facebook-upload.controller.ts).
export const getUploadHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit  = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const platform = ['youtube', 'tiktok', 'instagram', 'facebook'].includes(req.query.platform as string)
      ? (req.query.platform as string)
      : undefined;

    const items = platformVideoRepo.findHistory({ limit, offset, platform }).map((pv) => ({
      id:          pv.id,
      platform:    pv.platform,
      platformId:  pv.platform_id,
      platformUrl: pv.platform_url ?? null,
      publishedAt: pv.published_at ?? pv.created_at,
      title:       pv.title ?? null,
      fileName:    pv.file_name ?? null,
      linkedFileId: pv.linked_file_id ?? null,
      matchStatus: pv.match_status,
    }));
    const total = platformVideoRepo.countHistory(platform);

    res.json({ items, total });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/group-stats?limit=5 — para la vista de Estadísticas. Siempre arma
// los candidatos ACÁ desde la SQLite local (files.platforms), sin importar el tier:
// es la fuente más fresca para lo publicado desde esta misma app -- delegar a la
// central para premium sonaba mejor en el papel, pero su catálogo depende de un
// cross-match manual (PlatformVideoModel.linkedFileId) que no se actualiza solo y
// queda semanas atrás de lo último publicado. Solo se le pide a la central las
// stats en vivo por id (stats-by-ids), no el armado de candidatos.
export const getGroupStats = async (req: AuthRequest, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ message: 'Token requerido' }); return; }
  const limit = Math.min(parseInt(req.query.limit as string) || 5, 20);

  try {
    const candidates = platformVideoRepo.findGroupStatsCandidates(limit);
    const ids = {
      youtube:   candidates.map(c => c.platforms.youtube?.platformId).filter((x): x is string => !!x),
      instagram: candidates.map(c => c.platforms.instagram?.platformId).filter((x): x is string => !!x),
      tiktok:    candidates.map(c => c.platforms.tiktok?.platformId).filter((x): x is string => !!x),
    };

    let stats: Record<'youtube' | 'instagram' | 'tiktok', Record<string, { views: number; likes: number; comments: number }>> =
      { youtube: {}, instagram: {}, tiktok: {} };
    try {
      const upstream = await fetch(`${CENTRAL}/api/sync/stats-by-ids`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(ids),
      });
      if (upstream.ok) stats = await upstream.json();
    } catch { /* sin stats en vivo, se devuelven los videos igual con 0 */ }

    const items = candidates.map(c => {
      const platforms: Record<string, any> = {};
      for (const p of ['youtube', 'instagram', 'tiktok'] as const) {
        const slot = c.platforms[p];
        if (!slot) continue;
        const fresh = stats[p][slot.platformId];
        platforms[p] = {
          platformId:  slot.platformId,
          platformUrl: slot.platformUrl ?? '',
          title:       slot.title ?? '',
          thumbnail:   '',
          views:    fresh?.views    ?? 0,
          likes:    fresh?.likes    ?? 0,
          comments: fresh?.comments ?? 0,
        };
      }
      return { fileId: String(c.fileId), fileName: c.fileName, fecha_creacion: c.fechaCreacion, platforms };
    });

    res.json({ items });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/sync/calendar-config/:platform
export const updateCalendarConfig = (req: Request, res: Response): void => {
  const { platform } = req.params;
  if (!['tiktok', 'instagram', 'youtube'].includes(platform)) {
    res.status(400).json({ message: 'Plataforma no válida' }); return;
  }
  const { lastPublishedDate, lastPublishedTitle, intervalDays, lastVideoId, nextVideoId } = req.body;

  configRepo.setPlatformConfig(platform, {
    ...(lastPublishedDate  !== undefined ? { last_published_date:  lastPublishedDate  } : {}),
    ...(lastPublishedTitle !== undefined ? { last_published_title: lastPublishedTitle } : {}),
    ...(intervalDays       !== undefined ? { interval_days:        intervalDays       } : {}),
    ...('lastVideoId' in req.body ? { last_video_id: lastVideoId ?? null } : {}),
    ...('nextVideoId' in req.body ? { next_video_id: nextVideoId ?? null } : {}),
  });

  res.json({ ok: true });
};
