/**
 * Script: Populate platform_videos with real data from TikTok/Instagram/YouTube
 *
 * Usage:
 *   CENTRAL_API=https://api.esse-analytics.com \
 *   AUTH_TOKEN="Bearer eyJ..." \
 *   npx tsx src/scripts/populate-published-videos.ts
 *
 * Gets the latest published video from each platform and inserts into SQLite.
 */

import { platformVideoRepo } from '../db/platform-video.repo';
import { fileRepo } from '../db/file.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error('ERROR: AUTH_TOKEN env var required (Bearer <jwt>)');
  process.exit(1);
}

async function fetchToken(platform: 'tiktok' | 'instagram' | 'youtube') {
  try {
    const res = await fetch(`${CENTRAL}/api/${platform}/token`, {
      headers: { Authorization: AUTH_TOKEN },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  } catch (err: any) {
    console.error(`  ❌ Token fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchTikTokLatest(token: any): Promise<{ publish_id: string; url: string; title: string } | null> {
  try {
    // TikTok: fetch creator info (includes recent videos or use /post/publish/status/fetch for existing IDs)
    // Simpler: we'd need a different endpoint. For now, return null and user must have published via app.
    console.log('  ℹ TikTok: requires video to be published via app (API doesn\'t list past publishes)');
    return null;
  } catch (err: any) {
    console.error(`  ❌ TikTok fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchInstagramLatest(token: any): Promise<{ publish_id: string; url: string; title: string } | null> {
  try {
    // Instagram: GET /me/media to list published content
    const res = await fetch(
      `https://graph.instagram.com/me/media?fields=id,caption,media_type,permalink&access_token=${token.access_token}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const media = data.data?.[0];
    if (!media) return null;

    return {
      publish_id: media.id,
      url: media.permalink || `https://instagram.com/p/${media.id}`,
      title: media.caption || `[${media.media_type}]`,
    };
  } catch (err: any) {
    console.error(`  ❌ Instagram fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchYouTubeLatest(token: any): Promise<{ publish_id: string; url: string; title: string } | null> {
  try {
    // YouTube: GET /my_uploads to list uploaded videos
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?playlistId=UUploads&part=snippet&maxResults=1&access_token=${token.access_token}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items?.[0];
    if (!item) return null;

    const videoId = item.snippet.resourceId.videoId;
    return {
      publish_id: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: item.snippet.title,
    };
  } catch (err: any) {
    console.error(`  ❌ YouTube fetch failed: ${err.message}`);
    return null;
  }
}

async function run() {
  console.log('🔄 Populate platform_videos from live APIs...\n');

  const platforms = [
    { name: 'tiktok', fetcher: fetchTikTokLatest },
    { name: 'instagram', fetcher: fetchInstagramLatest },
    { name: 'youtube', fetcher: fetchYouTubeLatest },
  ] as const;

  let populated = 0;

  for (const { name, fetcher } of platforms) {
    console.log(`📱 ${name.toUpperCase()}:`);

    // Check if already exists
    const existing = platformVideoRepo.findLatestWithFileName(name);
    if (existing && existing.platform_id) {
      console.log(`  ✓ Already has published video: ${existing.platform_id}`);
      console.log(`    File: ${existing.file_name}\n`);
      continue;
    }

    // Fetch token
    console.log('  🔐 Fetching OAuth token...');
    const token = await fetchToken(name);
    if (!token) {
      console.log(`  ⚠ Skipping (no auth)\n`);
      continue;
    }

    // Fetch latest from platform
    console.log('  🌐 Fetching latest video...');
    const latest = await fetcher(token);
    if (!latest) {
      console.log(`  ⚠ No videos found or API unavailable\n`);
      continue;
    }

    console.log(`  ✓ Found: ${latest.title}`);

    // Try to find matching local file by title
    const allFiles = fileRepo.findAll({});
    const matched = allFiles.find(f => f.file_name === latest.title);

    if (matched) {
      console.log(`  ✓ Matched to local file: ${matched.file_name}`);
    } else {
      console.log(`  ℹ No matching local file (will insert without link)`);
    }

    // Insert into platform_videos
    platformVideoRepo.upsert({
      platform: name,
      platform_id: latest.publish_id,
      platform_url: latest.url,
      published_at: new Date().toISOString(),
      linked_file_id: matched?.id || null,
      match_status: matched ? 'auto' : 'manual',
    });

    console.log(`  ✅ Inserted platform_id: ${latest.publish_id}\n`);
    populated++;
  }

  console.log(`\n✨ Done. Populated ${populated} platform(s).`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
