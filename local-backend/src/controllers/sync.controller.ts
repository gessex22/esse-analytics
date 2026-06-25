import { Request, Response } from 'express';
import { fileRepo } from '../db/file.repo';
import { platformVideoRepo } from '../db/platform-video.repo';
import { configRepo } from '../db/config.repo';

// GET /api/sync/calendar-config
export const getCalendarConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const stored = configRepo.getAllPlatformConfigs();
    const storedMap = new Map(stored.map(c => [c.platform as string, c]));

    // YouTube: usa override si existe, si no calcula desde platform_videos
    let ytConfig: { platform: string; lastPublishedTitle: string; lastPublishedDate: string; intervalDays: number };
    const ytOverride = storedMap.get('youtube');

    if (ytOverride) {
      ytConfig = {
        platform:           'youtube',
        lastPublishedTitle: (ytOverride.last_published_title as string) ?? '',
        lastPublishedDate:  (ytOverride.last_published_date  as string) ?? '',
        intervalDays:       (ytOverride.interval_days as number) ?? 4,
      };
    } else {
      const ytVideos = platformVideoRepo.findByPlatformLinked('youtube', 7);

      ytConfig = { platform: 'youtube', lastPublishedTitle: '', lastPublishedDate: '', intervalDays: 4 };
      if (ytVideos.length > 0) {
        const diffs: number[] = [];
        for (let i = 0; i < Math.min(6, ytVideos.length - 1); i++) {
          diffs.push(Math.round(
            (new Date(ytVideos[i].published_at!).getTime() - new Date(ytVideos[i + 1].published_at!).getTime())
            / (1000 * 60 * 60 * 24)
          ));
        }
        const interval = diffs.length ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : 4;
        const linkedFile = ytVideos[0].linked_file_id ? fileRepo.findById(ytVideos[0].linked_file_id) : undefined;
        ytConfig = {
          platform:           'youtube',
          lastPublishedTitle: linkedFile?.file_name ?? '',
          lastPublishedDate:  ytVideos[0].published_at!.slice(0, 10),
          intervalDays:       interval,
        };
      }
    }

    const igTk = ['tiktok', 'instagram'].map(p => {
      const c = storedMap.get(p);
      return c
        ? { platform: p, lastPublishedTitle: c.last_published_title, lastPublishedDate: c.last_published_date, intervalDays: (c.interval_days as number) ?? 3, lastVideoId: c.last_video_id ?? null, nextVideoId: c.next_video_id ?? null }
        : { platform: p, lastPublishedTitle: '', lastPublishedDate: '', intervalDays: 3, lastVideoId: null, nextVideoId: null };
    });

    const allConfigs = [
      { ...ytConfig, lastVideoId: ytOverride?.last_video_id ?? null, nextVideoId: ytOverride?.next_video_id ?? null },
      ...igTk,
    ];

    const enriched = await Promise.all(allConfigs.map(async (cfg) => {
      if (!cfg.nextVideoId) return { ...cfg, nextVideo: null };
      try {
        const file = fileRepo.findById(String(cfg.nextVideoId));
        if (!file) return { ...cfg, nextVideo: null };
        return {
          ...cfg,
          nextVideo: {
            fileId:   String(file.id),
            title:    file.file_name,
            duration: file.duracion_segundos ? `${Math.floor(file.duracion_segundos / 60)}:${String(Math.floor(file.duracion_segundos % 60)).padStart(2, '0')}` : '',
          },
        };
      } catch {
        return { ...cfg, nextVideo: null };
      }
    }));

    res.json(enriched);
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
