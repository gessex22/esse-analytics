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
