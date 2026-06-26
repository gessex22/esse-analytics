const API_KEY    = process.env.YOUTUBE_API_KEY!;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID!;

async function main() {
  const url = `https://www.googleapis.com/youtube/v3/search?key=${API_KEY}&channelId=${CHANNEL_ID}&part=snippet&order=date&type=video&maxResults=5`;
  const res  = await fetch(url);
  const data = await res.json() as any;

  if (data.error) { console.error('Error:', JSON.stringify(data.error)); return; }

  console.log('Últimos 5 via search?order=date:');
  for (const item of data.items ?? []) {
    console.log(`  ${item.snippet.publishedAt?.slice(0,10)} | ${item.id.videoId} | "${item.snippet.title}"`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
