/**
 * Test TikTok API endpoints
 * Usage: AUTH_TOKEN="Bearer <jwt>" PUBLISH_ID="v_pub_file~..." npx tsx src/scripts/test-tiktok-api.ts
 */

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PUBLISH_ID = process.env.PUBLISH_ID || 'v_pub_file~v2-1.7655571416524539922';

if (!AUTH_TOKEN) {
  console.error('ERROR: AUTH_TOKEN env var required (Bearer <jwt>)');
  process.exit(1);
}

async function testStatusFetch() {
  console.log('\n=== 1. Testing /v2/post/publish/status/fetch/ ===\n');
  console.log(`PUBLISH_ID: ${PUBLISH_ID}`);

  try {
    const token = await fetchTokenFromCentral();
    if (!token) {
      console.error('❌ Failed to get token from central');
      return;
    }

    console.log(`✓ Got token: ${token.access_token?.slice(0, 30)}...`);

    const res = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publish_id: PUBLISH_ID }),
    });

    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (data.data?.video_id) {
      console.log(`\n✓ Got video_id: ${data.data.video_id}`);
      return data.data.video_id;
    } else {
      console.log('\n❌ No video_id in response');
      return null;
    }
  } catch (err: any) {
    console.error('❌ Error:', err.message);
    return null;
  }
}

async function testVideoList() {
  console.log('\n=== 2. Testing /v2/video/list/ ===\n');

  try {
    const token = await fetchTokenFromCentral();
    if (!token) {
      console.error('❌ Failed to get token from central');
      return;
    }

    const fields = 'id,video_description,video_cover_url,duration,create_time,like_count,view_count,share_count,comment_count';
    const url = `https://open.tiktokapis.com/v2/video/list/?fields=${fields}&access_token=${token.access_token}`;

    console.log(`Calling: /v2/video/list/?fields=${fields}`);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    const data = await res.json();
    console.log(`Status: ${res.status}`);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (data.data?.videos && data.data.videos.length > 0) {
      console.log(`\n✓ Got ${data.data.videos.length} video(s)`);
      console.log('First video:', JSON.stringify(data.data.videos[0], null, 2));
    } else {
      console.log('\n❌ No videos in response');
    }
  } catch (err: any) {
    console.error('❌ Error:', err.message);
  }
}

async function fetchTokenFromCentral() {
  try {
    const res = await fetch(`${CENTRAL}/api/tiktok/token`, {
      headers: { Authorization: AUTH_TOKEN },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  } catch (err: any) {
    console.error(`Failed to fetch token from central: ${err.message}`);
    return null;
  }
}

async function run() {
  console.log('🧪 TikTok API Test\n');
  const videoId = await testStatusFetch();
  await testVideoList();
  console.log('\n✨ Done');
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
