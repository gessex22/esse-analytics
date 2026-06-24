import { PlatformVideoModel } from '../models/platform-video.model';

const BASE = 'https://www.googleapis.com/youtube/v3';
const apiKey    = () => process.env.YOUTUBE_API_KEY    || '';
const channelId = () => process.env.YOUTUBE_CHANNEL_ID || '';

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

// Sincronización principal: trae todos los videos del canal y upserta en BD
export async function syncYouTubeChannel(): Promise<{ total: number; shorts: number; upserted: number }> {
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
      { platform: 'youtube', platformId: item.id },
      {
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

// Obtener los videos de YouTube ya guardados en BD
export async function getYouTubeVideos(page = 1, limit = 50) {
  const skip  = (page - 1) * limit;
  const total = await PlatformVideoModel.countDocuments({ platform: 'youtube' });
  const items = await PlatformVideoModel.find({ platform: 'youtube' })
    .sort({ publishedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  return { total, items };
}
