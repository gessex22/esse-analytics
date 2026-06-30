import { Request, Response } from 'express';

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

type TokenLike = { access_token: string; open_id?: string; [key: string]: any };

// Recorta texto largo (captions de IG / descripciones de TikTok pueden tener cientos
// de caracteres) para que no desborde las tarjetas ni infle el espejo a la central.
function clip(s: string | null | undefined, max = 90): string | null {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

// Pide a la central el token OAuth del usuario para una plataforma.
async function fetchToken(
  platform: 'tiktok' | 'instagram' | 'youtube',
  authHeader: string
): Promise<TokenLike | null> {
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

// ── Último publicado por plataforma — SIEMPRE en vivo desde la API ───────────────
// La tarjeta refleja lo que realmente está publicado en la plataforma, sin depender
// de platform_videos local. Si fue subido por fuera de la app, igual aparece.

async function fetchYouTubeLatest(token: TokenLike | null): Promise<PublishedVideo | null> {
  try {
    // 1. Resolver la playlist "uploads" del canal. Con OAuth → canal del usuario (mine).
    //    Sin token → fallback a API key + YOUTUBE_CHANNEL_ID (solo el dueño).
    let uploadsPlaylistId: string | null = null;

    if (token?.access_token) {
      const chRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true&access_token=${token.access_token}`
      );
      if (chRes.ok) {
        const chData = await chRes.json() as any;
        uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
      }
    }
    if (!uploadsPlaylistId && YT_API_KEY && process.env.YOUTUBE_CHANNEL_ID) {
      const chRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${process.env.YOUTUBE_CHANNEL_ID}&key=${YT_API_KEY}`
      );
      if (chRes.ok) {
        const chData = await chRes.json() as any;
        uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
      }
    }
    if (!uploadsPlaylistId) return null;

    // 2. Primer item de la playlist = último video subido.
    const authParam = token?.access_token ? `access_token=${token.access_token}` : `key=${YT_API_KEY}`;
    const plRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?playlistId=${uploadsPlaylistId}&part=snippet,contentDetails&maxResults=1&${authParam}`
    );
    if (!plRes.ok) return null;
    const plData = await plRes.json() as any;
    const item = plData.items?.[0];
    if (!item) return null;

    const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
    if (!videoId) return null;

    const stats: Record<string, any> = {
      thumbnail: item.snippet?.thumbnails?.maxres?.url
              || item.snippet?.thumbnails?.high?.url
              || item.snippet?.thumbnails?.medium?.url
              || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    };

    // 3. Estadísticas del video (API key pública es suficiente).
    const statParam = YT_API_KEY ? `key=${YT_API_KEY}` : `access_token=${token?.access_token}`;
    const vRes = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=statistics&${statParam}`
    );
    if (vRes.ok) {
      const vData = await vRes.json() as any;
      const v = vData.items?.[0];
      if (v) {
        stats.viewCount    = v.statistics?.viewCount;
        stats.likeCount    = v.statistics?.likeCount;
        stats.commentCount = v.statistics?.commentCount;
      }
    }

    return {
      platform:    'youtube',
      fileName:    null,
      platformId:  videoId,
      platformUrl: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: item.snippet?.publishedAt ?? null,
      title:       clip(item.snippet?.title),
      stats,
    };
  } catch {
    return null;
  }
}

// Vistas de un Reel via insights. Requiere el scope instagram_business_manage_insights;
// si el token no lo tiene, la API responde "permission" y devolvemos undefined (sin romper).
async function fetchInstagramViews(mediaId: string, accessToken: string): Promise<number | undefined> {
  try {
    const r = await fetch(
      `https://graph.instagram.com/v22.0/${mediaId}/insights?metric=views&access_token=${accessToken}`
    );
    const d = await r.json() as any;
    if (!r.ok || d.error) return undefined;
    const val = d.data?.[0]?.values?.[0]?.value ?? d.data?.[0]?.total_value?.value;
    return typeof val === 'number' ? val : undefined;
  } catch {
    return undefined;
  }
}

async function fetchInstagramLatest(token: TokenLike): Promise<PublishedVideo | null> {
  try {
    const fields = 'id,caption,media_type,media_product_type,permalink,thumbnail_url,like_count,comments_count,timestamp';
    const res = await fetch(
      `https://graph.instagram.com/v22.0/me/media?fields=${fields}&limit=1&access_token=${token.access_token}`
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.error) return null;
    const m = data.data?.[0];
    if (!m) return null;

    // Las vistas solo aplican a video/Reels y dependen del permiso de insights.
    const isVideo = m.media_product_type === 'REELS' || m.media_type === 'VIDEO';
    const views = isVideo ? await fetchInstagramViews(m.id, token.access_token) : undefined;

    return {
      platform:    'instagram',
      fileName:    null,
      platformId:  m.id,
      platformUrl: m.permalink ?? null,
      publishedAt: m.timestamp ?? null,
      title:       clip(m.caption),
      stats: {
        media_type:     m.media_product_type || m.media_type,
        views,
        like_count:     m.like_count ?? 0,
        comments_count: m.comments_count ?? 0,
        thumbnail:      m.thumbnail_url || null,
      },
    };
  } catch {
    return null;
  }
}

async function fetchTikTokLatest(token: TokenLike): Promise<PublishedVideo | null> {
  try {
    // /v2/video/list/ devuelve los videos del usuario ordenados por fecha desc.
    // OJO: el campo de miniatura es cover_image_url (NO video_cover_url, que da
    // invalid_params y tumba toda la request). Confirmado con scripts/test-tiktok-videolist.ts.
    const fields = 'id,video_description,cover_image_url,share_url,like_count,view_count,comment_count,share_count,create_time';
    const res = await fetch(
      `https://open.tiktokapis.com/v2/video/list/?fields=${fields}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ max_count: 1 }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const v = data.data?.videos?.[0];
    if (!v) return null;

    const openId = token.open_id;
    return {
      platform:    'tiktok',
      fileName:    null,
      platformId:  v.id,
      platformUrl: v.share_url
                || (openId ? `https://www.tiktok.com/@${openId}/video/${v.id}` : null),
      publishedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
      title:       clip(v.video_description),
      stats: {
        thumbnail: v.cover_image_url || null,
        // Claves que espera getStatChips() en el frontend.
        views:    v.view_count ?? undefined,
        likes:    v.like_count ?? undefined,
        comments: v.comment_count ?? undefined,
        shares:   v.share_count ?? undefined,
      },
    };
  } catch {
    return null;
  }
}

// GET /api/sync/published-videos
// Trae el último video publicado de cada plataforma EN VIVO desde su API.
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
      const token = await fetchToken(platform, authHeader);

      let card: PublishedVideo | null = null;
      if (platform === 'youtube') {
        // YouTube puede resolverse con token (canal del usuario) o API key + channel env.
        card = await fetchYouTubeLatest(token);
      } else if (token) {
        card = platform === 'tiktok'
          ? await fetchTikTokLatest(token)
          : await fetchInstagramLatest(token);
      }

      result.push(card ?? {
        platform,
        fileName: null,
        platformId: null,
        platformUrl: null,
        publishedAt: null,
      });
    }

    // Espejo a la central para que web/remoto vea las mismas tarjetas (ya frescas).
    mirrorToCentral(authHeader, result).catch(() => { /* no bloquear la respuesta local */ });

    // Fallback: si una plataforma no devolvió nada (sin token en este equipo, API caída),
    // rellenarla desde el espejo de la central para no dejar la tarjeta vacía.
    const filled = await fillEmptyFromCentral(authHeader, result);

    res.json(filled);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// Sube las tarjetas a la central (Mongo) sin bloquear la respuesta local.
async function mirrorToCentral(authHeader: string, cards: PublishedVideo[]): Promise<void> {
  const withId = cards.filter(c => c.platformId);
  if (withId.length === 0) return;
  await fetch(`${CENTRAL}/api/sync/published-videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ cards: withId }),
  });
}

// Rellena las tarjetas vacías (sin platformId) con las del espejo de la central.
async function fillEmptyFromCentral(authHeader: string, result: PublishedVideo[]): Promise<PublishedVideo[]> {
  if (!result.some(r => !r.platformId)) return result;   // ya están todas → nada que traer
  try {
    const res = await fetch(`${CENTRAL}/api/sync/published-videos`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return result;
    const mirror = (await res.json()) as PublishedVideo[];
    const byPlatform = new Map(mirror.map(m => [m.platform, m]));
    return result.map(r => {
      if (r.platformId) return r;                          // local ya tiene → respetar
      const m = byPlatform.get(r.platform);
      return m && m.platformId ? m : r;                    // usar espejo si trae datos
    });
  } catch {
    return result;
  }
}

// AuthRequest type (assuming it exists in your middleware)
interface AuthRequest extends Request {
  user?: any;
}
