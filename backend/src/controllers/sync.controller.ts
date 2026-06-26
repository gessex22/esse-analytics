import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncYouTubeChannel, getYouTubeVideos } from '../services/youtube.service';
import { PlatformVideoModel } from '../models/platform-video.model';
import { FileModel } from '../models/file.model';

export const triggerYouTubeSync = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await syncYouTubeChannel();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

export const getYouTubeList = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const data  = await getYouTubeVideos(page, limit);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

export const getSyncStats = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const youtube   = await PlatformVideoModel.countDocuments({ platform: 'youtube' });
    const instagram = await PlatformVideoModel.countDocuments({ platform: 'instagram' });
    const tiktok    = await PlatformVideoModel.countDocuments({ platform: 'tiktok' });
    const linked    = await PlatformVideoModel.countDocuments({ linkedFileId: { $ne: null } });
    const revisar   = await PlatformVideoModel.countDocuments({ matchStatus: 'revisar_manual' });
    const sinMatch  = await PlatformVideoModel.countDocuments({ matchStatus: 'sin_match' });
    res.json({ youtube, instagram, tiktok, linked, revisar, sinMatch });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/review — lista de videos YT pendientes de revisión manual con sus candidatos
export const getReviewList = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip  = (page - 1) * limit;

    const total = await PlatformVideoModel.countDocuments({ matchStatus: 'revisar_manual' });
    const items = await PlatformVideoModel.find({ matchStatus: 'revisar_manual' })
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
        ? await FileModel.find({ _id: { $in: candidateIds } })
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
    if (!fileId) { res.status(400).json({ message: 'fileId requerido' }); return; }

    await PlatformVideoModel.findByIdAndUpdate(pvId, {
      linkedFileId: new Types.ObjectId(fileId),
      matchStatus: 'manual',
      $unset: { matchCandidates: '' },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/review/:pvId/orphan — marca como huérfano
export const markOrphan = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { pvId } = req.params;
    await PlatformVideoModel.findByIdAndUpdate(pvId, {
      matchStatus: 'sin_match',
      $unset: { matchCandidates: '' },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/calendar-config — configuración real del calendario por plataforma
export const getCalendarConfig = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const db = (await import('mongoose')).default.connection.db!;

    // platform_config tiene overrides manuales para cualquier plataforma
    const stored = await db.collection('platform_config')
      .find({ platform: { $in: ['tiktok', 'instagram', 'youtube'] } })
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
      const ytVideos = await PlatformVideoModel.find({ platform: 'youtube', linkedFileId: { $ne: null } })
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
          file = await FileModel.findOne({ file_name: String(cfg.nextVideoId) })
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

    const db = (await import('mongoose')).default.connection.db!;
    await db.collection('platform_config').updateOne(
      { platform },
      { $set: fields },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};
