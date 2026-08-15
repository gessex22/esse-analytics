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
//
// Fallos reales (sin token, token vencido, error de la API de TikTok) TIENEN
// que tirar -- no devolver {items:[], nextCursor:null} como si fuera "no hay
// más resultados". Antes se devolvía silencioso acá y el cliente (SlotPicker
// en desktop, "Cargar más" en iOS/Android) no podía distinguir un error real
// de una lista terminada -- ver getPlatformRecent en sync.controller.ts, que
// traduce estos throws a HTTP claro en vez de tragárselos.
export async function getRecentTikTokVideos(userId: string, limit: number, cursor?: string): Promise<PlatformRecentPage> {
  // getValidToken ya tira 'NO_AUTH' si no hay conexión -- no atajarlo acá,
  // que suba tal cual (antes un catch mudo lo convertía en página vacía).
  const token = await getValidToken(userId);

  // OJO: el campo de miniatura es cover_image_url (NO video_cover_url, que da
  // invalid_params y tumba toda la request) — confirmado en local-backend.
  const fields = 'id,video_description,cover_image_url,share_url,like_count,view_count,comment_count,share_count,create_time';
  const body: Record<string, any> = { max_count: limit };
  // El cursor de TikTok es un timestamp -- la API lo exige numérico en el
  // body, pero de punta a punta (sync.controller.ts, clientes iOS/Android) se
  // sigue tratando como string opaca, nunca se inspecciona ni se genera acá.
  if (cursor) body.cursor = Number(cursor);

  const res = await fetch(`${TK_BASE}/video/list/?fields=${fields}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TikTok API error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  // La v2 de TikTok devuelve 200 con { error: { code: "ok", ... } } incluso
  // en éxito -- mismo chequeo que ya usa tiktok-upload.controller.ts para
  // init/info de subida.
  if (data.error?.code !== 'ok') throw new Error(data.error?.message || `TikTok API error: ${data.error?.code}`);
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

// Fecha real de publicación de UN video puntual -- mismo motivo que
// getVideoPublishedAt (YouTube) / getMediaPublishedAt (Instagram), mismo
// endpoint /video/query/ que getVideoStatsByIds pero pidiendo create_time.
export async function getVideoPublishedAt(userId: string, videoId: string): Promise<Date | null> {
  if (!/^\d+$/.test(videoId)) return null;
  try {
    const token = await getValidToken(userId);
    const res = await fetch(`${TK_BASE}/video/query/?fields=id,create_time`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filters: { video_ids: [videoId] } }),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const createTime = data.data?.videos?.[0]?.create_time;
    return typeof createTime === 'number' ? new Date(createTime * 1000) : null;
  } catch {
    return null;
  }
}

// Stats en vivo para un puñado puntual de video ids (ej. vista de Estadísticas)
// vía /v2/video/query/ — a diferencia de /video/list/ (que trae "los últimos N"),
// este permite pedir videos puntuales por id.
export async function getVideoStatsByIds(userId: string, videoIds: string[]): Promise<Record<string, { views: number; likes: number; comments: number; shares: number; thumbnail?: string }>> {
  // /video/query/ exige ids numéricos reales -- un solo publish_id o URL crudo
  // sin resolver mezclado en la lista (siempre puede quedar alguno: ver
  // resolveTikTokVideoId más arriba) hace que TikTok rechace el batch COMPLETO
  // con invalid_params, dejando en cero hasta los videos que sí tenían id
  // válido. Se filtran acá para que un id sin resolver no le robe las métricas
  // al resto.
  const validIds = videoIds.filter(id => /^\d+$/.test(id));
  if (validIds.length === 0) return {};
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
      body: JSON.stringify({ filters: { video_ids: validIds } }),
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
