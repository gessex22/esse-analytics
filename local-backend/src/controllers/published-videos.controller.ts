import { Request, Response } from 'express';
import { platformVideoRepo } from '../db/platform-video.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

type PublishedVideo = {
  platform: string;
  fileName: string | null;
  platformId: string | null;
  platformUrl: string | null;
  publishedAt: string | null;
  title?: string | null;
  status?: string | null;
  stats?: Record<string, any>;
};

async function fetchToken(
  platform: 'tiktok' | 'instagram' | 'youtube',
  authHeader: string
): Promise<{ access_token: string; [key: string]: any } | null> {
  try {
    const res = await fetch(`${CENTRAL}/api/${platform}/token`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchTikTokVideoData(
  publishId: string,
  token: { access_token: string; [key: string]: any }
): Promise<Partial<PublishedVideo>> {
  try {
    const res = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const videoData = data.data ?? {};

    // TikTok also provides video_cover_cover_url (thumbnail) if available
    return {
      status: videoData.status,
      stats: {
        video_id: videoData.video_id,
        fail_reason: videoData.fail_reason,
        likes: videoData.like_count || 0,
        shares: videoData.share_count || 0,
        comments: videoData.comment_count || 0,
        views: videoData.view_count || 0,
        thumbnail: videoData.video_cover_url || null,
      },
    };
  } catch {
    return {};
  }
}

async function fetchInstagramVideoData(
  publishId: string,
  token: { access_token: string; [key: string]: any }
): Promise<Partial<PublishedVideo>> {
  try {
    const fields = 'status,media_type,caption,media_product_type,thumbnail_url,insights.metric(engagement,impressions,reach)';
    const res = await fetch(
      `https://graph.instagram.com/${publishId}?fields=${fields}&access_token=${token.access_token}`
    );
    if (!res.ok) return {};
    const data = await res.json();
    const insights = data.insights?.data || [];
    const engagement = insights.find((i: any) => i.name === 'engagement')?.values?.[0]?.value || 0;
    const likes = insights.find((i: any) => i.name === 'impressions')?.values?.[0]?.value || 0;

    return {
      status: data.status,
      title: data.caption || null,
      stats: {
        media_type: data.media_product_type || data.media_type,
        engagement: engagement,
        likes: likes,
        thumbnail: data.thumbnail_url || null,
      },
    };
  } catch {
    return {};
  }
}

async function fetchYouTubeVideoData(
  videoId: string,
  token: { access_token: string; [key: string]: any }
): Promise<Partial<PublishedVideo>> {
  try {
    const parts = 'snippet,statistics,fileDetails';
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=${parts}&access_token=${token.access_token}`
    );
    if (!res.ok) return {};
    const data = await res.json();
    const video = data.items?.[0];
    if (!video) return {};
    return {
      title: video.snippet?.title || null,
      stats: {
        viewCount: video.statistics?.viewCount,
        likeCount: video.statistics?.likeCount,
        commentCount: video.statistics?.commentCount,
        thumbnail: video.snippet?.thumbnails?.medium?.url || null,
        description: video.snippet?.description || null,
      },
    };
  } catch {
    return {};
  }
}

// GET /api/sync/published-videos/refresh
// Fetches live data from each platform's API for the latest published video
export const getPublishedVideosRefresh = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'No authorization header' });
      return;
    }

    const platforms = ['tiktok', 'instagram', 'youtube'] as const;
    const result: PublishedVideo[] = [];

    for (const platform of platforms) {
      const latest = platformVideoRepo.findLatestWithFileName(platform);

      if (!latest || !latest.platform_id) {
        result.push({
          platform,
          fileName: null,
          platformId: null,
          platformUrl: null,
          publishedAt: null,
        });
        continue;
      }

      // Base video info
      const baseVideo: PublishedVideo = {
        platform,
        fileName: latest.file_name ?? null,
        platformId: latest.platform_id,
        platformUrl: latest.platform_url ?? null,
        publishedAt: latest.published_at ?? null,
      };

      // Fetch fresh data from platform API
      const token = await fetchToken(platform, authHeader);
      if (!token) {
        result.push(baseVideo);
        continue;
      }

      let freshData: Partial<PublishedVideo> = {};
      if (platform === 'tiktok') {
        freshData = await fetchTikTokVideoData(latest.platform_id, token);
      } else if (platform === 'instagram') {
        freshData = await fetchInstagramVideoData(latest.platform_id, token);
      } else if (platform === 'youtube') {
        freshData = await fetchYouTubeVideoData(latest.platform_id, token);
      }

      result.push({ ...baseVideo, ...freshData });
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// AuthRequest type (assuming it exists in your middleware)
interface AuthRequest extends Request {
  user?: any;
}
