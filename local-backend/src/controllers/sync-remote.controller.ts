import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { platformVideoRepo } from '../db/platform-video.repo';
import { publishingStatusRepo } from '../db/publishing-status.repo';
import { configRepo } from '../db/config.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// POST /api/sync/pull-remote-uploads
// Obtiene uploads remotos de la central y sincroniza con SQLite local
export const pullRemoteUploads = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Sin autenticación' });
      return;
    }

    // Obtener uploads remotos de la central (últimas 24h)
    const centralRes = await fetch(`${CENTRAL}/api/sync/remote-uploads?sinceSecs=86400`, {
      headers: { Authorization: authHeader },
    });

    if (!centralRes.ok) {
      res.status(centralRes.status).json({ error: 'No se pudo obtener uploads remotos de la central' });
      return;
    }

    const data = await centralRes.json() as {
      ok: boolean;
      count: number;
      uploads: Array<{
        platform: 'youtube' | 'instagram' | 'tiktok';
        platformId: string;
        platformUrl: string;
        title: string;
        description: string;
        thumbnail: string;
        publishedAt: string;
        stats?: Record<string, any>;
      }>;
    };

    if (!data.ok || !data.uploads) {
      res.json({ ok: true, synced: 0, message: 'Sin nuevos uploads remotos' });
      return;
    }

    let synced = 0;

    for (const upload of data.uploads) {
      // Guardar en platform_video
      platformVideoRepo.upsert({
        platform: upload.platform,
        platform_id: upload.platformId,
        platform_url: upload.platformUrl,
        title: upload.title?.slice(0, 300) || undefined,
        description: upload.description?.slice(0, 500) || undefined,
        published_at: new Date(upload.publishedAt),
        thumbnail: upload.thumbnail,
        match_status: 'remote',
      });

      // Marcar en config como publicado
      configRepo.markPublished(upload.platform, upload.title, null, null);

      // Crear/actualizar publishing_status
      publishingStatusRepo.upsert(
        null, // Sin fileId para uploads remotos
        upload.title || 'Remote Upload',
        {
          [upload.platform + '_published']: true,
        }
      );

      synced++;
    }

    res.json({ ok: true, synced, message: `Sincronizados ${synced} uploads remotos` });
  } catch (err: any) {
    console.error('Error in pullRemoteUploads:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/sync/last-remote-upload/:platform
// Obtiene el último upload remoto de una plataforma (para verificar if está sincronizado)
export const getLastRemoteUpload = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { platform } = req.params;
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Sin autenticación' });
      return;
    }

    const centralRes = await fetch(`${CENTRAL}/api/sync/remote-uploads?sinceSecs=604800`, { // Última semana
      headers: { Authorization: authHeader },
    });

    if (!centralRes.ok) {
      res.status(500).json({ error: 'No se pudo obtener uploads remotos' });
      return;
    }

    const data = await centralRes.json() as { uploads: Array<{ platform: string; [key: string]: any }> };
    const lastUpload = data.uploads?.find((u: any) => u.platform === platform);

    if (!lastUpload) {
      res.json({ ok: true, upload: null });
      return;
    }

    res.json({ ok: true, upload: lastUpload });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/sync/pull-next-videos
// Sincroniza los próximos videos configurados en la central con el local
export const pullNextVideos = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Sin autenticación' });
      return;
    }

    // Obtener próximos videos de la central
    const centralRes = await fetch(`${CENTRAL}/api/sync/next-videos`, {
      headers: { Authorization: authHeader },
    });

    if (!centralRes.ok) {
      res.status(centralRes.status).json({ error: 'No se pudo obtener próximos videos de la central' });
      return;
    }

    const data = await centralRes.json() as {
      ok: boolean;
      nextVideos: Array<{
        platform: string;
        nextVideoId: string | null;
        nextVideoTitle: string | null;
      }>;
    };

    if (!data.ok || !data.nextVideos) {
      res.json({ ok: true, synced: 0 });
      return;
    }

    let synced = 0;

    for (const config of data.nextVideos) {
      // Actualizar en SQLite local
      configRepo.setPlatformConfig(config.platform as any, {
        next_video_id: config.nextVideoId ?? null,
        next_video_title: config.nextVideoTitle ?? null,
      });
      synced++;
    }

    res.json({ ok: true, synced, message: `Sincronizados ${synced} próximos videos` });
  } catch (err: any) {
    console.error('Error in pullNextVideos:', err.message);
    res.status(500).json({ error: err.message });
  }
};
