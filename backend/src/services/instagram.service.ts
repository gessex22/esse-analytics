// Instagram Graph API — lectura de medios recientes para el matching entre
// plataformas (ver sync.controller.ts). La subida en sí vive en
// instagram-upload.controller.ts; acá solo reutilizamos sus tokens.
import { loadTokens, isUsableInstagramConnection } from '../controllers/instagram-upload.controller';

const FB_GRAPH = 'https://graph.facebook.com/v22.0';

export interface PlatformRecentItem {
  platformId:  string;
  title:       string;
  thumbnail:   string;
  publishedAt: string;
  platformUrl: string | null;
  stats: Record<string, any>;
}

export interface PlatformRecentPage {
  items: PlatformRecentItem[];
  nextCursor: string | null;
}

function clip(s: string | null | undefined, max = 90): string {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

// Últimos N posts/reels de video de la cuenta de IG Business conectada. `after`
// es el cursor de paginación de Graph API — se pasa tal cual como vino en la
// página anterior para poder seguir yendo hacia atrás en el tiempo (necesario
// porque cada plataforma publica a un ritmo distinto: IG/TikTok pueden ir muy
// adelante de YouTube y con un solo lote fijo nunca se llega a la misma fecha).
export async function getRecentInstagramMedia(userId: string, limit: number, after?: string): Promise<PlatformRecentPage> {
  const tokens = await loadTokens(userId);
  if (!isUsableInstagramConnection(tokens)) return { items: [], nextCursor: null };

  const fields = 'id,caption,media_type,media_product_type,permalink,thumbnail_url,timestamp,like_count,comments_count';
  const url = `${FB_GRAPH}/${tokens!.instagram_user_id}/media?fields=${fields}&limit=${limit}`
    + (after ? `&after=${encodeURIComponent(after)}` : '')
    + `&access_token=${tokens!.access_token}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [], nextCursor: null };
  const data = await res.json() as any;
  if (data.error) return { items: [], nextCursor: null };

  const items = (data.data ?? [])
    .filter((m: any) => m.media_product_type === 'REELS' || m.media_type === 'VIDEO')
    .map((m: any) => ({
      platformId:  m.id,
      title:       clip(m.caption) || '(sin descripción)',
      thumbnail:   m.thumbnail_url || '',
      publishedAt: m.timestamp ?? '',
      platformUrl: m.permalink ?? null,
      stats: {
        like_count:     m.like_count ?? 0,
        comments_count: m.comments_count ?? 0,
      },
    }));

  return { items, nextCursor: data.paging?.cursors?.after ?? null };
}

// Un link de Instagram pegado a mano (ver extractPlatformId en el editor de
// escritorio) solo puede sacar el shortcode del permalink (ej. "DbKtpt1RRLv")
// -- Graph API no acepta eso como media id para nada (stats, insights), así
// que sin resolver el id numérico real las vistas/likes/comentarios de ese
// reel quedan en 0 para siempre. Busca por coincidencia de permalink entre
// los medios recientes de la cuenta; si no aparece (video fuera de la
// ventana reciente) devuelve null y el caller sigue con el shortcode tal
// cual, sin bloquear el link/badge.
export async function resolveInstagramMediaId(userId: string, urlOrId: string): Promise<string | null> {
  if (/^\d+$/.test(urlOrId)) return urlOrId;
  const shortcodeMatch = urlOrId.match(/instagram\.com\/(?:reel|p|tv)\/([a-zA-Z0-9_-]+)/);
  const shortcode = shortcodeMatch ? shortcodeMatch[1] : urlOrId;
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const { items, nextCursor } = await getRecentInstagramMedia(userId, 25, cursor);
    const match = items.find((i) => i.platformUrl?.includes(shortcode));
    if (match) return match.platformId;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return null;
}

// Las vistas de un Reel NO vienen en los campos básicos del media — hay que
// pedirlas aparte via /insights. Si el token no tiene el scope
// instagram_business_manage_insights, la API responde error de permiso y acá
// se devuelve 0 en vez de romper el resto de las stats.
async function fetchInsightViews(mediaId: string, accessToken: string): Promise<number> {
  try {
    const r = await fetch(`${FB_GRAPH}/${mediaId}/insights?metric=views&access_token=${accessToken}`);
    const d = await r.json() as any;
    if (!r.ok || d.error) return 0;
    const val = d.data?.[0]?.values?.[0]?.value ?? d.data?.[0]?.total_value?.value;
    return typeof val === 'number' ? val : 0;
  } catch {
    return 0;
  }
}

// Stats en vivo para un puñado puntual de media ids (ej. vista de Estadísticas).
// Graph API no soporta traer varios media ids sueltos en una sola llamada, así
// que va uno por uno — está bien acotado a los ~5 videos de esa vista.
export async function getMediaStats(userId: string, mediaIds: string[]): Promise<Record<string, { views: number; likes: number; comments: number; thumbnail?: string }>> {
  const tokens = await loadTokens(userId);
  if (!isUsableInstagramConnection(tokens) || mediaIds.length === 0) return {};

  const result: Record<string, { views: number; likes: number; comments: number; thumbnail?: string }> = {};
  await Promise.all(mediaIds.map(async (id) => {
    try {
      // thumbnail_url sumado acá para completar PlatformVideoModel.thumbnail
      // sin una llamada aparte -- mismo campo que getRecentInstagramMedia.
      const [res, views] = await Promise.all([
        fetch(`${FB_GRAPH}/${id}?fields=like_count,comments_count,thumbnail_url&access_token=${tokens!.access_token}`),
        fetchInsightViews(id, tokens!.access_token),
      ]);
      if (!res.ok) return;
      const data = await res.json() as any;
      if (data.error) return;
      result[id] = { views, likes: data.like_count ?? 0, comments: data.comments_count ?? 0, thumbnail: data.thumbnail_url || undefined };
    } catch { /* deja el id afuera del resultado — el caller conserva el valor guardado */ }
  }));
  return result;
}
