// TikTok API — lectura de videos recientes para el matching entre plataformas
// (ver sync.controller.ts). La subida en sí vive en tiktok-upload.controller.ts;
// acá solo reutilizamos su token (con refresh automático incluido).
import { getValidToken } from '../controllers/tiktok-upload.controller';
import type { PlatformRecentItem, PlatformRecentPage } from './instagram.service';

const TK_BASE = 'https://open.tiktokapis.com/v2';

function clip(s: string | null | undefined, max = 90): string {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

// Cualquier id que NO sea puramente numérico es sospechoso -- el real de un
// video de TikTok siempre lo es. Lo más común es un publish_id crudo (formato
// "v_pub_file~..."/"v_pub_url~...", el id de la OPERACIÓN de publicar, no del
// video -- ver tiktok-upload.controller.ts) que se guardó como si fuera el id
// real. Red de seguridad centralizada, mismo criterio que
// resolveInstagramMediaId: mientras cada uploader (central/local-backend/iOS/
// Android) ya resuelve esto en su propio flujo de subida, cualquier OTRO
// caller (un link pegado a mano, un cliente futuro, un bug que reintroduzca
// un publish_id crudo) pasa igual por acá antes de guardarse en Mongo.
export async function resolveTikTokVideoId(userId: string, platformIdOrPublishId: string): Promise<string | null> {
  if (/^\d+$/.test(platformIdOrPublishId)) return platformIdOrPublishId;
  let token: { access_token: string };
  try {
    token = await getValidToken(userId);
  } catch {
    return null;
  }
  try {
    const res = await fetch(`${TK_BASE}/post/publish/status/fetch/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: platformIdOrPublishId }),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Viene como número JSON de 64 bits -- JSON.parse le pierde precisión
    // (pasa Number.MAX_SAFE_INTEGER), así que se extrae del texto crudo.
    const match = text.match(/"publicaly_available_post_id"\s*:\s*\[\s*(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Últimos N videos del usuario, ordenados por fecha desc. `cursor` es el que
// devuelve la API en `data.cursor` — hay que reenviarlo para seguir yendo hacia
// atrás en el tiempo (TikTok suele publicar mucho más seguido que YouTube/IG,
// así que sin paginar real nunca se llega a la misma fecha que las otras ruedas).
export async function getRecentTikTokVideos(userId: string, limit: number, cursor?: string): Promise<PlatformRecentPage> {
  let token: { access_token: string; open_id: string };
  try {
    token = await getValidToken(userId);
  } catch {
    return { items: [], nextCursor: null };
  }

  // OJO: el campo de miniatura es cover_image_url (NO video_cover_url, que da
  // invalid_params y tumba toda la request) — confirmado en local-backend.
  const fields = 'id,video_description,cover_image_url,share_url,like_count,view_count,comment_count,share_count,create_time';
  const body: Record<string, any> = { max_count: limit };
  if (cursor) body.cursor = Number(cursor);

  const res = await fetch(`${TK_BASE}/video/list/?fields=${fields}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { items: [], nextCursor: null };
  const data = await res.json() as any;
  const videos = data.data?.videos ?? [];

  const items: PlatformRecentItem[] = videos.map((v: any) => ({
    platformId:  v.id,
    title:       clip(v.video_description) || '(sin descripción)',
    thumbnail:   v.cover_image_url || '',
    publishedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : '',
    platformUrl: v.share_url || (token.open_id ? `https://www.tiktok.com/@${token.open_id}/video/${v.id}` : null),
    stats: {
      views:    v.view_count ?? 0,
      likes:    v.like_count ?? 0,
      comments: v.comment_count ?? 0,
      shares:   v.share_count ?? 0,
    },
  }));

  const nextCursor = data.data?.has_more && data.data?.cursor ? String(data.data.cursor) : null;
  return { items, nextCursor };
}

// Stats en vivo para un puñado puntual de video ids (ej. vista de Estadísticas)
// vía /v2/video/query/ — a diferencia de /video/list/ (que trae "los últimos N"),
// este permite pedir videos puntuales por id.
export async function getVideoStatsByIds(userId: string, videoIds: string[]): Promise<Record<string, { views: number; likes: number; comments: number; shares: number; thumbnail?: string }>> {
  if (videoIds.length === 0) return {};
  let token: { access_token: string };
  try {
    token = await getValidToken(userId);
  } catch {
    return {};
  }

  try {
    // cover_image_url sumado acá para completar PlatformVideoModel.thumbnail
    // sin una llamada aparte -- mismo campo que getRecentTikTokVideos.
    const res = await fetch(`${TK_BASE}/video/query/?fields=id,like_count,view_count,comment_count,share_count,cover_image_url`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filters: { video_ids: videoIds } }),
    });
    if (!res.ok) return {};
    const data = await res.json() as any;
    const videos = data.data?.videos ?? [];
    const result: Record<string, { views: number; likes: number; comments: number; shares: number; thumbnail?: string }> = {};
    for (const v of videos) {
      result[v.id] = {
        views:    v.view_count    ?? 0,
        likes:    v.like_count    ?? 0,
        comments: v.comment_count ?? 0,
        shares:   v.share_count   ?? 0,
        thumbnail: v.cover_image_url || undefined,
      };
    }
    return result;
  } catch {
    return {};
  }
}
