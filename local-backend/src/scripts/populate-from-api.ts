/**
 * Populate platform_videos from live Instagram and YouTube APIs
 * Uses MongoDB tokens directly — no JWT needed.
 *
 * Run: SQLITE_PATH="C:\Users\Gessemberg\AppData\Roaming\esse-analytics-desktop\esse_local.db" \
 *      npx tsx src/scripts/populate-from-api.ts
 */
import { MongoClient } from 'mongodb';
import { platformVideoRepo } from '../db/platform-video.repo';

const MONGO_URI        = process.env.MONGO_URI!;
const IG_GRAPH         = 'https://graph.instagram.com/v22.0';
const YT_API           = 'https://www.googleapis.com/youtube/v3';
const YT_CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID!;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET!;

async function refreshYouTubeToken(refreshToken: string): Promise<string | null> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     YT_CLIENT_ID,
      client_secret: YT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json() as any;
  if (data.error) { console.error('  YT refresh error:', data.error); return null; }
  return data.access_token;
}

async function populateInstagram(tokenDoc: any) {
  const { access_token, instagram_user_id } = tokenDoc;
  if (!access_token || !instagram_user_id) { console.log('  ❌ No token/user_id'); return; }

  // Check existing
  const existing = platformVideoRepo.findLatestWithFileName('instagram');
  if (existing?.platform_id) {
    console.log(`  ✓ Ya existe: ${existing.platform_id} → "${existing.file_name ?? 'sin archivo'}"`);
    return;
  }

  const fields = 'id,caption,media_type,permalink,thumbnail_url,timestamp';
  const res = await fetch(`${IG_GRAPH}/${instagram_user_id}/media?fields=${fields}&limit=5&access_token=${access_token}`);
  const data = await res.json() as any;

  console.log('  API response:', JSON.stringify(data, null, 2));

  const media = data.data?.find((m: any) => m.media_type === 'VIDEO' || m.media_type === 'REELS') ?? data.data?.[0];
  if (!media) { console.log('  ❌ No media found'); return; }

  console.log(`  ✓ Found: ${media.id} — "${(media.caption ?? '').slice(0, 60)}"`);

  platformVideoRepo.upsert({
    platform:     'instagram',
    platform_id:  media.id,
    platform_url: media.permalink ?? `https://www.instagram.com/p/${media.id}`,
    published_at: media.timestamp ? new Date(media.timestamp) : new Date(),
    match_status: 'remote',
    title:        media.caption ? media.caption.slice(0, 300) : undefined,
  });
  console.log('  ✅ Guardado en platform_videos');
}

async function populateYouTube(tokenDoc: any) {
  let accessToken: string = tokenDoc.tokens?.access_token;
  const refreshToken: string = tokenDoc.tokens?.refresh_token;

  if (!accessToken && !refreshToken) { console.log('  ❌ No tokens'); return; }

  // Check existing
  const existing = platformVideoRepo.findLatestWithFileName('youtube');
  if (existing?.platform_id) {
    console.log(`  ✓ Ya existe: ${existing.platform_id} → "${existing.file_name ?? 'sin archivo'}"`);
    return;
  }

  // Try to get uploads playlist via channel info
  let res = await fetch(`${YT_API}/channels?part=contentDetails&mine=true&access_token=${accessToken}`);
  let data = await res.json() as any;

  // If token expired, refresh
  if (data.error?.code === 401 && refreshToken) {
    console.log('  🔄 Token expirado — refrescando...');
    const newToken = await refreshYouTubeToken(refreshToken);
    if (!newToken) { console.log('  ❌ No se pudo refrescar'); return; }
    accessToken = newToken;
    res = await fetch(`${YT_API}/channels?part=contentDetails&mine=true&access_token=${accessToken}`);
    data = await res.json() as any;
  }

  const uploadsPlaylistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    console.log('  API response:', JSON.stringify(data, null, 2));
    console.log('  ❌ No se encontró playlist de uploads');
    return;
  }
  console.log(`  ✓ Uploads playlist: ${uploadsPlaylistId}`);

  // Get latest video from uploads playlist
  const playlistRes = await fetch(
    `${YT_API}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=1&access_token=${accessToken}`
  );
  const playlistData = await playlistRes.json() as any;
  const item = playlistData.items?.[0];
  if (!item) {
    console.log('  API response:', JSON.stringify(playlistData, null, 2));
    console.log('  ❌ No videos en playlist');
    return;
  }

  const videoId = item.snippet.resourceId.videoId;
  const title   = item.snippet.title;
  const publishedAt = item.snippet.publishedAt;
  console.log(`  ✓ Último video: ${videoId} — "${title}"`);

  platformVideoRepo.upsert({
    platform:     'youtube',
    platform_id:  videoId,
    platform_url: `https://www.youtube.com/watch?v=${videoId}`,
    published_at: publishedAt ? new Date(publishedAt) : new Date(),
    match_status: 'remote',
    title,
  });
  console.log('  ✅ Guardado en platform_videos');
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');

  // Get most recent token per platform
  const igToken = await db.collection('oauth_tokens').findOne({ provider: 'instagram' }, { sort: { updatedAt: -1 } });
  const ytToken = await db.collection('oauth_tokens').findOne({ provider: 'youtube'   }, { sort: { updatedAt: -1 } });

  console.log('\n📱 INSTAGRAM:');
  if (!igToken) console.log('  ❌ Sin token conectado');
  else await populateInstagram(igToken);

  console.log('\n📺 YOUTUBE:');
  if (!ytToken) console.log('  ❌ Sin token conectado');
  else await populateYouTube(ytToken);

  await client.close();
  console.log('\n✨ Done');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
