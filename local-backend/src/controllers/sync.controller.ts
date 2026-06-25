import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { PlatformVideoModel } from '../models/platform-video.model';

// GET /api/sync/calendar-config
export const getCalendarConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = mongoose.connection.db!;

    const stored = await db.collection('platform_config')
      .find({ platform: { $in: ['tiktok', 'instagram', 'youtube'] } })
      .toArray();

    const storedMap = new Map(stored.map(c => [c.platform as string, c]));

    // YouTube: usa override si existe, si no calcula desde platformvideos
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
      const ytVideos = await PlatformVideoModel.find({ platform: 'youtube', linkedFileId: { $ne: null } })
        .sort({ publishedAt: -1 }).limit(7).lean();

      ytConfig = { platform: 'youtube', lastPublishedTitle: '', lastPublishedDate: '', intervalDays: 4 };
      if (ytVideos.length > 0) {
        const diffs: number[] = [];
        for (let i = 0; i < Math.min(6, ytVideos.length - 1); i++) {
          diffs.push(Math.round(
            (new Date(ytVideos[i].publishedAt!).getTime() - new Date(ytVideos[i + 1].publishedAt!).getTime())
            / (1000 * 60 * 60 * 24)
          ));
        }
        const interval = diffs.length ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : 4;
        const linkedFile = await FileModel.findById(ytVideos[0].linkedFileId).select('file_name').lean();
        ytConfig = {
          platform:           'youtube',
          lastPublishedTitle: linkedFile?.file_name ?? '',
          lastPublishedDate:  new Date(ytVideos[0].publishedAt!).toISOString().slice(0, 10),
          intervalDays:       interval,
        };
      }
    }

    const igTk = ['tiktok', 'instagram'].map(p => {
      const c = storedMap.get(p);
      return c
        ? { platform: p, lastPublishedTitle: c.lastPublishedTitle, lastPublishedDate: c.lastPublishedDate, intervalDays: c.intervalDays ?? 3, lastVideoId: c.lastVideoId ?? null, nextVideoId: c.nextVideoId ?? null }
        : { platform: p, lastPublishedTitle: '', lastPublishedDate: '', intervalDays: 3, lastVideoId: null, nextVideoId: null };
    });

    const allConfigs = [
      { ...ytConfig, lastVideoId: ytOverride?.lastVideoId ?? null, nextVideoId: ytOverride?.nextVideoId ?? null },
      ...igTk,
    ];

    const enriched = await Promise.all(allConfigs.map(async (cfg) => {
      if (!cfg.nextVideoId) return { ...cfg, nextVideo: null };
      try {
        const file = await FileModel.findById(new mongoose.Types.ObjectId(String(cfg.nextVideoId)))
          .select('file_name duracion_segundos').lean();
        if (!file) return { ...cfg, nextVideo: null };
        const dur = (file as any).duracion_segundos as number | undefined;
        return {
          ...cfg,
          nextVideo: {
            fileId:   String(file._id),
            title:    (file as any).file_name,
            duration: dur ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}` : '',
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
export const updateCalendarConfig = async (req: Request, res: Response): Promise<void> => {
  try {
    const { platform } = req.params;
    if (!['tiktok', 'instagram', 'youtube'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' }); return;
    }
    const { lastPublishedDate, lastPublishedTitle, intervalDays, lastVideoId, nextVideoId } = req.body;
    const fields: Record<string, unknown> = {};
    if (lastPublishedDate  !== undefined) fields.lastPublishedDate  = lastPublishedDate;
    if (lastPublishedTitle !== undefined) fields.lastPublishedTitle = lastPublishedTitle;
    if (intervalDays       !== undefined) fields.intervalDays       = intervalDays;
    if (lastVideoId        !== undefined) fields.lastVideoId        = lastVideoId;
    if (nextVideoId        !== undefined) fields.nextVideoId        = nextVideoId;

    const db = mongoose.connection.db!;
    await db.collection('platform_config').updateOne({ platform }, { $set: fields }, { upsert: true });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};
