import { MongoClient } from 'mongodb';
import 'dotenv/config';

const MONGO_URI = process.env.MONGO_URI!;

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');

  const tokenDoc = await db.collection('oauth_tokens')
    .findOne({ provider: 'tiktok' }, { sort: { updatedAt: -1 } });

  if (!tokenDoc) {
    console.log('❌ No TikTok token found in MongoDB');
    await client.close();
    return;
  }

  console.log('✓ Token found — userId:', tokenDoc.userId);
  console.log('  Updated at:', tokenDoc.updatedAt);
  console.log('  Scope stored:', tokenDoc.scope ?? '(not stored)');
  console.log('  access_token:', tokenDoc.access_token?.slice(0, 30) + '...');

  console.log('\n=== Calling /v2/video/list/ ===\n');
  const fields = 'id,video_description,cover_image_url,share_url,duration,create_time,like_count,view_count,share_count,comment_count,title';

  // Attempt 1: video/list (public only by default)
  console.log('--- Attempt 1: video/list (default) ---');
  const res = await fetch(
    `https://open.tiktokapis.com/v2/video/list/?fields=${fields}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenDoc.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ max_count: 20 }),
    }
  );
  const data = await res.json() as any;
  console.log('HTTP Status:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));

  // Attempt 2: video/query — puede incluir videos privados
  console.log('\n--- Attempt 2: video/query ---');
  const res2 = await fetch(
    `https://open.tiktokapis.com/v2/video/query/?fields=${fields}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenDoc.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filters: { video_ids: [] }, max_count: 5 }),
    }
  );
  const data2 = await res2.json() as any;
  console.log('HTTP Status:', res2.status);
  console.log('Response:', JSON.stringify(data2, null, 2));

  if (data.data?.videos?.length > 0) {
    console.log(`\n✅ SUCCESS — ${data.data.videos.length} video(s) retrieved`);
    console.log('First video:', JSON.stringify(data.data.videos[0], null, 2));
  } else if (data.error?.code === 'scope_not_authorized') {
    console.log('\n❌ SCOPE NOT AUTHORIZED — token creado sin video.list');
    console.log('   → Desconecta y reconecta TikTok en la app para obtener nuevo token');
  } else if (data.data?.videos?.length === 0) {
    console.log('\n✅ SCOPE FUNCIONA — pero no hay videos en la cuenta');
  } else {
    console.log('\n⚠️  Respuesta inesperada');
  }

  await client.close();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
