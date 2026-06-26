/**
 * Populate platform_videos (Instagram + YouTube) from live APIs.
 * Runs from backend dir (has mongodb + jsonwebtoken).
 * Calls local-backend at port 4000 to insert SQLite records.
 *
 * Run: npx tsx --env-file=.env src/scripts/populate-ig-yt.ts
 */
import { MongoClient } from 'mongodb';
import jwt from 'jsonwebtoken';

const MONGO_URI        = process.env.MONGO_URI!;
const JWT_SECRET       = 'esse_secret_key_2024';
const LOCAL_BACKEND    = 'http://localhost:4000';
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
  if (data.error) { console.error('  YT refresh error:', data.error, data.error_description); return null; }
  return data.access_token;
}

async function insertViaSQLite(authHeader: string, platform: string, data: {
  platform_id: string;
  platform_url: string;
  published_at: string;
  title?: string;
}) {
  // Call the local-backend sync endpoint to insert — actually we'll call a direct route
  // Since there's no direct upsert endpoint, use fetch to the local backend
  // The local-backend exposes no direct write endpoint for platform_videos,
  // so we POST to its internal route. Instead, just open the DB directly.
  // We use better-sqlite3 from the electron app's path.
  const dbPath = 'C:\\Users\\Gessemberg\\AppData\\Roaming\\esse-analytics-desktop\\esse_local.db';
  const { default: Database } = await import('better-sqlite3' as any).catch(() => ({ default: null }));
  if (!Database) {
    console.log('  ⚠ better-sqlite3 not available from backend — skipping DB write');
    console.log('  → Data that would be inserted:', JSON.stringify(data));
    return false;
  }
  const db = new Database(dbPath);

  const existing = db.prepare(
    'SELECT id FROM platform_videos WHERE platform = ? AND platform_id = ?'
  ).get(platform, data.platform_id);

  if (existing) {
    console.log('  ✓ Ya existe en SQLite');
    db.close();
    return true;
  }

  db.prepare(`
    INSERT INTO platform_videos (platform, platform_id, platform_url, published_at, match_status, title)
    VALUES (?, ?, ?, ?, 'remote', ?)
  `).run(platform, data.platform_id, data.platform_url, data.published_at, data.title ?? null);

  db.close();
  return true;
}

async function doInstagram(igToken: any, authHeader: string) {
  const { access_token, instagram_user_id } = igToken;
  if (!access_token || !instagram_user_id) { console.log('  ❌ Sin access_token/instagram_user_id'); return; }

  const fields = 'id,caption,media_type,permalink,thumbnail_url,timestamp';
  const res = await fetch(`${IG_GRAPH}/${instagram_user_id}/media?fields=${fields}&limit=5&access_token=${access_token}`);
  const data = await res.json() as any;

  if (data.error) { console.log('  ❌ API error:', JSON.stringify(data.error)); return; }

  const media = data.data?.find((m: any) => m.media_type === 'VIDEO' || m.media_type === 'REELS')
             ?? data.data?.[0];
  if (!media) { console.log('  ❌ No media'); return; }

  console.log(`  ✓ ${media.id} — type=${media.media_type} — "${(media.caption ?? '').slice(0, 60)}"`);
  console.log(`  permalink: ${media.permalink}`);
  console.log(`  published: ${media.timestamp}`);

  await insertViaSQLite(authHeader, 'instagram', {
    platform_id:  media.id,
    platform_url: media.permalink ?? `https://www.instagram.com/p/${media.id}`,
    published_at: media.timestamp ?? new Date().toISOString(),
    title:        media.caption?.slice(0, 300),
  });
}

async function doYouTube(ytToken: any, authHeader: string) {
  let accessToken: string = ytToken.tokens?.access_token;
  const refreshToken: string = ytToken.tokens?.refresh_token;

  if (!accessToken && !refreshToken) { console.log('  ❌ Sin tokens'); return; }

  // Try channels endpoint, refresh if expired
  let res = await fetch(`${YT_API}/channels?part=contentDetails&mine=true&access_token=${accessToken}`);
  let data = await res.json() as any;

  if (data.error?.code === 401 && refreshToken) {
    console.log('  🔄 Token expirado — refrescando...');
    const newToken = await refreshYouTubeToken(refreshToken);
    if (!newToken) { console.log('  ❌ No se pudo refrescar'); return; }
    accessToken = newToken;
    res = await fetch(`${YT_API}/channels?part=contentDetails&mine=true&access_token=${accessToken}`);
    data = await res.json() as any;
  }

  if (data.error) { console.log('  ❌ channels error:', JSON.stringify(data.error)); return; }

  const uploadsId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) { console.log('  ❌ No uploads playlist'); return; }
  console.log(`  ✓ Uploads playlist: ${uploadsId}`);

  const plRes = await fetch(
    `${YT_API}/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=1&access_token=${accessToken}`
  );
  const plData = await plRes.json() as any;
  const item = plData.items?.[0];
  if (!item) { console.log('  ❌ No videos'); return; }

  const videoId = item.snippet.resourceId.videoId;
  const title   = item.snippet.title;
  const publishedAt = item.snippet.publishedAt;

  console.log(`  ✓ Último video: ${videoId} — "${title}"`);
  console.log(`  URL: https://www.youtube.com/watch?v=${videoId}`);
  console.log(`  published: ${publishedAt}`);

  await insertViaSQLite(authHeader, 'youtube', {
    platform_id:  videoId,
    platform_url: `https://www.youtube.com/watch?v=${videoId}`,
    published_at: publishedAt ?? new Date().toISOString(),
    title,
  });
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');

  const igToken = await db.collection('oauth_tokens').findOne({ provider: 'instagram' }, { sort: { updatedAt: -1 } });
  const ytToken = await db.collection('oauth_tokens').findOne({ provider: 'youtube' },   { sort: { updatedAt: -1 } });

  const userId = igToken?.userId ?? ytToken?.userId ?? 'unknown';
  const authHeader = 'Bearer ' + jwt.sign({ id: userId, role: 'user' }, JWT_SECRET, { expiresIn: '1h' });

  console.log('\n📸 INSTAGRAM:');
  if (!igToken) console.log('  ❌ Sin token conectado');
  else await doInstagram(igToken, authHeader);

  console.log('\n▶️  YOUTUBE:');
  if (!ytToken) console.log('  ❌ Sin token conectado');
  else await doYouTube(ytToken, authHeader);

  await client.close();
  console.log('\n✨ Done');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
