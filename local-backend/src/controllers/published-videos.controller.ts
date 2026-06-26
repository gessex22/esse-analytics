import { Request, Response } from 'express';
import { platformVideoRepo } from '../db/platform-video.repo';

const CENTRAL    = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
const YT_API_KEY = process.env.YOUTUBE_API_KEY || '';

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
    // Step 1: Get status and video_id
    const statusRes = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    if (!statusRes.ok) return {};
    const statusData = await statusRes.json();
    const videoData = statusData.data ?? {};
    const videoId = videoData.video_id;

    let videoInfo: any = {};

    // Step 2: If we have video_id, fetch description and thumbnail from /video/list/
    if (videoId) {
      try {
        const listRes = await fetch(
          `https://open.tiktokapis.com/v2/video/list/?fields=id,video_description,video_cover_url,duration,create_time&access_token=${token.access_token}`,
          { headers: { Authorization: `Bearer ${token.access_token}` } }
        );
        if (listRes.ok) {
          const listData = await listRes.json();
          const video = listData.data?.videos?.find((v: any) => v.id === videoId);
          if (video) {
            videoInfo = {
              description: video.video_description || null,
              thumbnail: video.video_cover_url || null,
              duration: video.duration || null,
            };
          }
        }
      } catch {
        // video/list fetch failed, continue with status-only data
      }
    }

    return {
      status: videoData.status,
      title: videoInfo.description || null,
      stats: {
        video_id: videoId,
        fail_reason: videoData.fail_reason,
        thumbnail: videoInfo.thumbnail || null,
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
    const fields = 'id,caption,media_type,media_product_type,permalink,thumbnail_url,like_count,comments_count,timestamp';
    const res = await fetch(
      `https://graph.instagram.com/v22.0/${publishId}?fields=${fields}&access_token=${token.access_token}`
    );
    if (!res.ok) return {};
    const data = await res.json() as any;
    if (data.error) return {};

    return {
      title: data.caption || null,
      stats: {
        media_type:     data.media_product_type || data.media_type,
        like_count:     data.like_count ?? 0,
        comments_count: data.comments_count ?? 0,
        thumbnail:      data.thumbnail_url || null,
      },
    };
  } catch {
    return {};
  }
}

async function fetchYouTubeVideoData(
  videoId: string,
  token?: { access_token: string; [key: string]: any }
): Promise<Partial<PublishedVideo>> {
  const fallbackThumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  try {
    // API key is sufficient for public video stats — no OAuth needed
    const param = YT_API_KEY ? `key=${YT_API_KEY}` : `access_token=${token?.access_token}`;
    if (!YT_API_KEY && !token) return { stats: { thumbnail: fallbackThumbnail } };
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,statistics&${param}`
    );
    if (!res.ok) return { stats: { thumbnail: fallbackThumbnail } };
    const data = await res.json() as any;
    const video = data.items?.[0];
    if (!video) return { stats: { thumbnail: fallbackThumbnail } };
    return {
      title: video.snippet?.title || null,
      stats: {
        viewCount:    video.statistics?.viewCount,
        likeCount:    video.statistics?.likeCount,
        commentCount: video.statistics?.commentCount,
        thumbnail:    video.snippet?.thumbnails?.maxres?.url
                   || video.snippet?.thumbnails?.high?.url
                   || video.snippet?.thumbnails?.medium?.url
                   || fallbackThumbnail,
      },
    };
  } catch {
    return { stats: { thumbnail: fallbackThumbnail } };
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

      // Base video info — stored title/description as fallback for private videos
      const baseVideo: PublishedVideo = {
        platform,
        fileName: latest.file_name ?? null,
        platformId: latest.platform_id,
        platformUrl: latest.platform_url ?? null,
        publishedAt: latest.published_at ?? null,
        title: (latest as any).title ?? null,
        stats: (latest as any).description ? { description: (latest as any).description } : undefined,
      };

      let freshData: Partial<PublishedVideo> = {};

      if (platform === 'youtube') {
        // YouTube usa API key pública — no necesita token OAuth
        freshData = await fetchYouTubeVideoData(latest.platform_id);
      } else {
        // TikTok e Instagram sí requieren token OAuth
        const token = await fetchToken(platform, authHeader);
        if (!token) {
          result.push(baseVideo);
          continue;
        }
        if (platform === 'tiktok') {
          freshData = await fetchTikTokVideoData(latest.platform_id, token);
        } else if (platform === 'instagram') {
          freshData = await fetchInstagramVideoData(latest.platform_id, token);
        }
      }

      // Merge: API data wins, but fall back to stored title if API returns nothing
      const merged = { ...baseVideo, ...freshData };
      if (!merged.title && baseVideo.title) merged.title = baseVideo.title;
      result.push(merged);
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
