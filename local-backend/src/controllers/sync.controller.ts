import { Request, Response } from 'express';
import { fileRepo } from '../db/file.repo';
import { platformVideoRepo } from '../db/platform-video.repo';
import { configRepo } from '../db/config.repo';

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
      const latest = platformVideoRepo.findLatestWithFileName(platform);
      if (!latest) {
        return { platform, fileName: null, platformId: null, platformUrl: null, publishedAt: null };
      }
      return {
        platform,
        fileName:    latest.file_name ?? null,
        platformId:  latest.platform_id,
        platformUrl: latest.platform_url ?? null,
        publishedAt: latest.published_at ?? null,
      };
    });
    res.json(result);
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
