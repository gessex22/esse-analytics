import { PlatformVideoModel } from '../models/platform-video.model';
import type { PlatformRecentItem, PlatformRecentPage } from './instagram.service';
import { env } from '../config/env';

const BASE = 'https://www.googleapis.com/youtube/v3';
const apiKey    = () => env.YOUTUBE_API_KEY;
const channelId = () => env.YOUTUBE_CHANNEL_ID;

// ISO 8601 duration → segundos (ej: PT1M3S → 63)
function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const h = parseInt(match[1] ?? '0');
  const m = parseInt(match[2] ?? '0');
  const s = parseInt(match[3] ?? '0');
  return h * 3600 + m * 60 + s;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Paso 1: obtener el ID de la playlist "uploads" del canal
async function getUploadsPlaylistId(): Promise<string> {
  const url = `${BASE}/channels?id=${channelId()}&part=contentDetails&key=${apiKey()}`;
  const data = await fetchJson<any>(url);
  const playlistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error('No se encontró la playlist de uploads del canal.');
  return playlistId;
}

// Paso 2: obtener todos los video IDs de la playlist (paginado)
async function getAllVideoIds(playlistId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';

  do {
    const url = `${BASE}/playlistItems?playlistId=${playlistId}&maxResults=50&part=contentDetails${pageToken ? `&pageToken=${pageToken}` : ''}&key=${apiKey()}`;
    const data = await fetchJson<any>(url);
    for (const item of data.items ?? []) {
      const id = item.contentDetails?.videoId;
      if (id) ids.push(id);
    }
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);

  return ids;
}

// Paso 3: obtener detalles en lotes de 50
async function getVideoDetails(ids: string[]): Promise<any[]> {
  const results: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).join(',');
    const url = `${BASE}/videos?id=${batch}&part=snippet,statistics,contentDetails,status&key=${apiKey()}`;
    const data = await fetchJson<any>(url);
    results.push(...(data.items ?? []));
  }
  return results;
}

// Sin filtro de duración — sincronizamos todos los videos del canal.
// El matching contra archivos locales se encarga de encontrar correspondencias.
function isShort(_item: any): boolean {
  return true;
}

// Sincronización principal: trae todos los videos del canal y upserta en BD.
// NOTA: el canal en sí sigue siendo global (YOUTUBE_CHANNEL_ID por env, no por OAuth
// del usuario) — eso es una limitación mayor aparte. Lo que sí se resuelve acá es que
// los registros resultantes queden scoped a quien disparó la sync, no compartidos.
export async function syncYouTubeChannel(userId: string): Promise<{ total: number; shorts: number; upserted: number }> {
  const playlistId = await getUploadsPlaylistId();
  const allIds     = await getAllVideoIds(playlistId);
  const details    = await getVideoDetails(allIds);

  let upserted = 0;
  let shorts   = 0;

  for (const item of details) {
    const duration = parseDuration(item.contentDetails?.duration ?? '');
    if (!isShort(item)) continue;
    shorts++;

    const privacyStatus = item.status?.privacyStatus ?? 'public';
    const status = privacyStatus === 'public'   ? 'public'
                 : privacyStatus === 'private'  ? 'private'
                 : privacyStatus === 'unlisted' ? 'unlisted'
                 : 'public';

    await PlatformVideoModel.findOneAndUpdate(
      { userId, platform: 'youtube', platformId: item.id },
      {
        userId,
        platform:        'youtube',
        platformId:      item.id,
        platformUrl:     `https://www.youtube.com/shorts/${item.id}`,
        title:           item.snippet?.title ?? '',
        description:     item.snippet?.description ?? '',
        publishedAt:     new Date(item.snippet?.publishedAt),
        durationSeconds: duration,
        thumbnail:       item.snippet?.thumbnails?.high?.url
                      ?? item.snippet?.thumbnails?.medium?.url
                      ?? item.snippet?.thumbnails?.default?.url
                      ?? '',
        views:           parseInt(item.statistics?.viewCount    ?? '0'),
        likes:           parseInt(item.statistics?.likeCount    ?? '0'),
        comments:        parseInt(item.statistics?.commentCount ?? '0'),
        status,
        lastSyncedAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' }
    );
    upserted++;
  }

  return { total: allIds.length, shorts, upserted };
}

// Fecha real de publicación de UN video puntual -- la usa applyPlatformPublish
// cuando el caller no manda publishedAt (típico: un link pegado a mano para un
// video ya publicado hace tiempo, ver setPlatformLink en local-backend). Sin
// esto, applyPlatformPublish caía a `new Date()` y el video quedaba marcado
// como "publicado ahora" aunque en realidad fuera viejo (bug real detectado
// 2026-08-15 con un link de Instagram de abril mostrado como recién
// publicado). getVideoDetails ya pide `part=snippet`, que trae publishedAt.
export async function getVideoPublishedAt(videoId: string): Promise<Date | null> {
  try {
    const [item] = await getVideoDetails([videoId]);
    const raw = item?.snippet?.publishedAt;
    return raw ? new Date(raw) : null;
  } catch {
    return null;
  }
}

// Stats en vivo para un puñado puntual de videos (ej. la vista de Estadísticas,
// acotada a 5 videos) — a diferencia de getYouTubeVideos, no lee de Mongo.
export async function getVideoStats(ids: string[]): Promise<Record<string, { views: number; likes: number; comments: number; thumbnail?: string }>> {
  if (ids.length === 0) return {};
  const details = await getVideoDetails(ids);
  const result: Record<string, { views: number; likes: number; comments: number; thumbnail?: string }> = {};
  for (const item of details) {
    result[item.id] = {
      views:    parseInt(item.statistics?.viewCount    ?? '0'),
      likes:    parseInt(item.statistics?.likeCount    ?? '0'),
      comments: parseInt(item.statistics?.commentCount ?? '0'),
      // getVideoDetails ya pide `part=snippet`, que trae thumbnails -- se
      // aprovecha acá para completar PlatformVideoModel.thumbnail sin pegarle
      // una llamada aparte a la API.
      thumbnail: item.snippet?.thumbnails?.high?.url
              ?? item.snippet?.thumbnails?.medium?.url
              ?? item.snippet?.thumbnails?.default?.url,
    };
  }
  return result;
}

// Página EN VIVO directo del canal (para el buscador de "Emparejar entre
// plataformas") — a diferencia de getYouTubeVideos, no depende de que
// syncYouTubeChannel se haya corrido antes: si el video ya está publicado en
// YouTube, aparece acá aunque nunca se haya hecho un "Re-sincronizar" completo.
// `cursor` es el pageToken nativo de la API (igual que el `after` de Instagram).
export async function getRecentYouTubeVideosLive(limit: number, cursor?: string): Promise<PlatformRecentPage> {
  const playlistId = await getUploadsPlaylistId();
  const url = `${BASE}/playlistItems?playlistId=${playlistId}&maxResults=${limit}`
    + (cursor ? `&pageToken=${cursor}` : '')
    + `&part=contentDetails,snippet&key=${apiKey()}`;
  const data = await fetchJson<any>(url);

  const ids = (data.items ?? [])
    .map((it: any) => it.contentDetails?.videoId)
    .filter(Boolean) as string[];
  const details = await getVideoDetails(ids);
  const statsById = new Map(details.map(d => [d.id, d.statistics ?? {}]));

  const items: PlatformRecentItem[] = (data.items ?? [])
    .filter((it: any) => it.contentDetails?.videoId)
    .map((it: any) => {
      const id = it.contentDetails.videoId;
      const stats = statsById.get(id) ?? {};
      return {
        platformId:  id,
        title:       it.snippet?.title ?? '',
        thumbnail:   it.snippet?.thumbnails?.high?.url
                  ?? it.snippet?.thumbnails?.medium?.url
                  ?? it.snippet?.thumbnails?.default?.url
                  ?? '',
        publishedAt: it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt ?? '',
        platformUrl: `https://www.youtube.com/shorts/${id}`,
        stats: {
          views:    parseInt(stats.viewCount    ?? '0'),
          likes:    parseInt(stats.likeCount    ?? '0'),
          comments: parseInt(stats.commentCount ?? '0'),
        },
      };
    });

  return { items, nextCursor: data.nextPageToken ?? null };
}

// Obtener los videos de YouTube ya guardados en BD
export async function getYouTubeVideos(userId: string, page = 1, limit = 50) {
  const skip  = (page - 1) * limit;
  const total = await PlatformVideoModel.countDocuments({ userId, platform: 'youtube' });
  const items = await PlatformVideoModel.find({ userId, platform: 'youtube' })
    .sort({ publishedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  return { total, items };
}
