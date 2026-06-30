import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { PublishedCardModel } from '../models/published-card.model';

const BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_API_KEY = () => process.env.YOUTUBE_API_KEY || '';

// ── YouTube: Obtener stats de un video específico ────────────────────────────
async function getYouTubeStats(videoId: string): Promise<{
  viewCount: number;
  likeCount: number;
  commentCount: number;
  thumbnail: string;
} | null> {
  try {
    const url = `${BASE}/videos?id=${videoId}&part=statistics,snippet&key=${YOUTUBE_API_KEY()}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`YouTube API error ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const item = data.items?.[0];
    if (!item) return null;

    return {
      viewCount: parseInt(item.statistics?.viewCount ?? '0', 10),
      likeCount: parseInt(item.statistics?.likeCount ?? '0', 10),
      commentCount: parseInt(item.statistics?.commentCount ?? '0', 10),
      thumbnail: item.snippet?.thumbnails?.high?.url
        ?? item.snippet?.thumbnails?.medium?.url
        ?? item.snippet?.thumbnails?.default?.url
        ?? '',
    };
  } catch (err: any) {
    console.error(`Error fetching YouTube stats for ${videoId}:`, err.message);
    return null;
  }
}

// ── Instagram: Obtener stats de un media específico ────────────────────────
async function getInstagramStats(mediaId: string, accessToken: string): Promise<{
  like_count: number;
  comments_count: number;
  thumbnail: string;
} | null> {
  try {
    // Requiere que el usuario haya autorizado Instagram
    const url = `https://graph.instagram.com/${mediaId}?fields=like_count,comments_count,media_type,media_product_type&access_token=${accessToken}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Instagram API error ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    return {
      like_count: data.like_count ?? 0,
      comments_count: data.comments_count ?? 0,
      thumbnail: data.thumbnail_url ?? '', // Aún no implementado en Graph API
    };
  } catch (err: any) {
    console.error(`Error fetching Instagram stats for ${mediaId}:`, err.message);
    return null;
  }
}

// ── TikTok: Obtener stats de un video específico ────────────────────────────
async function getTikTokStats(videoId: string, accessToken: string): Promise<{
  views: number;
  likes: number;
  comments: number;
  thumbnail: string;
} | null> {
  try {
    // Requiere aprobación oficial como partner de TikTok
    const url = `https://open.tiktok.com/v1/video/query/?video_id=${videoId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error(`TikTok API error ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const video = data.data?.[0];
    if (!video) return null;

    return {
      views: video.view_count ?? 0,
      likes: video.like_count ?? 0,
      comments: video.comment_count ?? 0,
      thumbnail: video.cover_image_url ?? '',
    };
  } catch (err: any) {
    console.error(`Error fetching TikTok stats for ${videoId}:`, err.message);
    return null;
  }
}

// ── GET /api/sync/published-stats/:platform/:platformId ────────────────────
// Obtiene stats reales de la plataforma y actualiza PublishedCardModel
export async function getPublishedStats(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { platform, platformId } = req.params;

    if (!['youtube', 'instagram', 'tiktok'].includes(platform)) {
      res.status(400).json({ error: 'Platform debe ser youtube, instagram o tiktok' });
      return;
    }

    let stats: any = null;

    if (platform === 'youtube') {
      stats = await getYouTubeStats(platformId);
    } else if (platform === 'instagram') {
      // TODO: Obtener token de Instagram del usuario de req.user
      // const token = user.instagramToken;
      // stats = await getInstagramStats(platformId, token);
      res.status(501).json({ error: 'Instagram stats aún no implementado' });
      return;
    } else if (platform === 'tiktok') {
      // TODO: Obtener token de TikTok del usuario de req.user
      // const token = user.tiktokToken;
      // stats = await getTikTokStats(platformId, token);
      res.status(501).json({ error: 'TikTok stats aún no implementado' });
      return;
    }

    if (!stats) {
      res.status(404).json({ error: 'No se pudieron obtener stats de la plataforma' });
      return;
    }

    // Guardar en PublishedCardModel
    await PublishedCardModel.findOneAndUpdate(
      { userId, platform },
      { $set: { stats } },
      { upsert: false, returnDocument: 'after' }
    );

    res.json({ ok: true, stats });
  } catch (err: any) {
    console.error('Error in getPublishedStats:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// ── POST /api/sync/refresh-all-stats ────────────────────────────────────────
// Refresca stats de todos los videos publicados del usuario (fuerza sincronización)
export async function refreshAllStats(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const cards = await PublishedCardModel.find({ userId });

    const results: any = {};

    for (const card of cards) {
      if (card.platform === 'youtube' && card.platformId) {
        const stats = await getYouTubeStats(card.platformId);
        if (stats) {
          await PublishedCardModel.findByIdAndUpdate(card._id, { $set: { stats } });
          results[card.platform] = { ok: true, stats };
        } else {
          results[card.platform] = { ok: false, error: 'No se obtuvieron stats' };
        }
      }
      // TODO: Instagram y TikTok
    }

    res.json({ ok: true, results });
  } catch (err: any) {
    console.error('Error in refreshAllStats:', err.message);
    res.status(500).json({ error: err.message });
  }
}
