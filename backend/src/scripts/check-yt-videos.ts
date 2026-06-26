import { MongoClient } from 'mongodb';

const MONGO_URI        = process.env.MONGO_URI!;
const YT_API           = 'https://www.googleapis.com/youtube/v3';
const YT_CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID!;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET!;

async function refreshToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  });
  const d = await res.json() as any;
  if (d.error) throw new Error(d.error + ': ' + d.error_description);
  return d.access_token;
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');
  const ytDoc = await db.collection('oauth_tokens').findOne({ provider: 'youtube' }, { sort: { updatedAt: -1 } });
  await client.close();

  let token = ytDoc?.tokens?.access_token as string;
  const refresh = ytDoc?.tokens?.refresh_token as string;

  // Get uploads playlist
  let res = await fetch(`${YT_API}/channels?part=contentDetails&mine=true&access_token=${token}`);
  let data = await res.json() as any;
  if (data.error?.code === 401) {
    console.log('Refrescando token...');
    token = await refreshToken(refresh);
    res = await fetch(`${YT_API}/channels?part=contentDetails&mine=true&access_token=${token}`);
    data = await res.json() as any;
  }

  const uploadsId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  console.log('Uploads playlist:', uploadsId);

  // Get last 5 videos
  const plRes = await fetch(
    `${YT_API}/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=5&access_token=${token}`
  );
  const plData = await plRes.json() as any;

  console.log('\nÚltimos 5 videos en YouTube:');
  for (const item of plData.items ?? []) {
    const v = item.snippet;
    console.log(`  ${v.publishedAt?.slice(0,10)} | ${v.resourceId.videoId} | "${v.title}"`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
