import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthRequest } from '../middleware/auth.middleware';
import { PublishedCardModel } from '../models/published-card.model';

const BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_API_KEY = () => process.env.YOUTUBE_API_KEY || '';

// ── Token helpers ─────────────────────────────────────────────────────────────
async function loadToken(userId: string, provider: 'youtube' | 'instagram' | 'tiktok'): Promise<any | null> {
  const db = mongoose.connection.db!;
  const doc = await db.collection('oauth_tokens').findOne({ provider, userId });
  return doc?.tokens ?? null;
}

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
  reach?: number;
  impressions?: number;
} | null> {
  try {
    // Instagram Graph API v18.0+
    // Campos disponibles: like_count, comments_count, media_type, caption, timestamp, thumbnail_url, permalink
    const url = `https://graph.instagram.com/v18.0/${mediaId}?fields=like_count,comments_count,media_type,caption,timestamp,thumbnail_url,permalink&access_token=${accessToken}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Instagram API error ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json() as any;

    // Obtener insights si es posible
    let reach = 0;
    let impressions = 0;
    try {
      const insightsUrl = `https://graph.instagram.com/v18.0/${mediaId}/insights?metric=reach,impressions&access_token=${accessToken}`;
      const insightsRes = await fetch(insightsUrl);
      if (insightsRes.ok) {
        const insightsData = await insightsRes.json() as any;
        const metricsMap = new Map(insightsData.data?.map((m: any) => [m.name, m.values?.[0]?.value ?? 0]));
        reach = metricsMap.get('reach') ?? 0;
        impressions = metricsMap.get('impressions') ?? 0;
      }
    } catch (_e) {
      // Si no se obtienen insights, continuar sin ellos
    }

    return {
      like_count: data.like_count ?? 0,
      comments_count: data.comments_count ?? 0,
      thumbnail: data.thumbnail_url ?? data.permalink ?? '',
      reach,
      impressions,
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
  shares: number;
  thumbnail: string;
} | null> {
  try {
    // TikTok Open API v1 - Requiere aprobación oficial como partner
    // Endpoint: POST /v1/video/query/
    const url = 'https://open.tiktok.com/v1/video/query/';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filters: {
          video_ids: [videoId],
        },
        fields: ['id', 'title', 'cover_image_url', 'view_count', 'like_count', 'comment_count', 'share_count'],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`TikTok API error ${res.status}: ${errText}`);
      return null;
    }

    const data = await res.json() as any;
    const video = data.data?.[0];
    if (!video) {
      console.error('No video data in TikTok response');
      return null;
    }

    return {
      views: video.view_count ?? 0,
      likes: video.like_count ?? 0,
      comments: video.comment_count ?? 0,
      shares: video.share_count ?? 0,
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
      const token = await loadToken(userId, 'instagram');
      if (!token) {
        res.status(401).json({ error: 'Instagram no está conectado. Autoriza tu cuenta primero.' });
        return;
      }
      stats = await getInstagramStats(platformId, token.access_token);
    } else if (platform === 'tiktok') {
      const token = await loadToken(userId, 'tiktok');
      if (!token) {
        res.status(401).json({ error: 'TikTok no está conectado. Autoriza tu cuenta primero.' });
        return;
      }
      stats = await getTikTokStats(platformId, token.access_token);
    }

    if (!stats) {
      res.status(404).json({ error: 'No se pudieron obtener stats de la plataforma. Verifica que el video aún esté disponible.' });
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
          results['youtube'] = { ok: true, count: (results['youtube']?.count ?? 0) + 1, lastStats: stats };
        } else {
          results['youtube'] = { ok: false, error: 'No se obtuvieron stats', count: 0 };
        }
      } else if (card.platform === 'instagram' && card.platformId) {
        const token = await loadToken(userId, 'instagram');
        if (!token) {
          results['instagram'] = { ok: false, error: 'Instagram no está conectado' };
        } else {
          const stats = await getInstagramStats(card.platformId, token.access_token);
          if (stats) {
            await PublishedCardModel.findByIdAndUpdate(card._id, { $set: { stats } });
            results['instagram'] = { ok: true, count: (results['instagram']?.count ?? 0) + 1, lastStats: stats };
          } else {
            results['instagram'] = { ok: false, error: 'No se obtuvieron stats', count: 0 };
          }
        }
      } else if (card.platform === 'tiktok' && card.platformId) {
        const token = await loadToken(userId, 'tiktok');
        if (!token) {
          results['tiktok'] = { ok: false, error: 'TikTok no está conectado' };
        } else {
          const stats = await getTikTokStats(card.platformId, token.access_token);
          if (stats) {
            await PublishedCardModel.findByIdAndUpdate(card._id, { $set: { stats } });
            results['tiktok'] = { ok: true, count: (results['tiktok']?.count ?? 0) + 1, lastStats: stats };
          } else {
            results['tiktok'] = { ok: false, error: 'No se obtuvieron stats', count: 0 };
          }
        }
      }
    }

    res.json({ ok: true, results });
  } catch (err: any) {
    console.error('Error in refreshAllStats:', err.message);
    res.status(500).json({ error: err.message });
  }
}
