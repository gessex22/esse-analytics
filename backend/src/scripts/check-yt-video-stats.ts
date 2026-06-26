async function main() {
  const API_KEY = process.env.YOUTUBE_API_KEY!;
  const VIDEO_ID = 'nIJzMFfvQlE';

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?id=${VIDEO_ID}&part=snippet,statistics&key=${API_KEY}`
  );
  const data = await res.json() as any;
  const v = data.items?.[0];
  if (!v) { console.log('No video:', JSON.stringify(data)); return; }

  console.log('title:      ', v.snippet?.title);
  console.log('thumbnail maxres:', v.snippet?.thumbnails?.maxres?.url ?? '(none)');
  console.log('thumbnail high:  ', v.snippet?.thumbnails?.high?.url ?? '(none)');
  console.log('thumbnail medium:', v.snippet?.thumbnails?.medium?.url ?? '(none)');
  console.log('views:      ', v.statistics?.viewCount);
  console.log('likes:      ', v.statistics?.likeCount);
  console.log('comments:   ', v.statistics?.commentCount);
}
main().catch(e => { console.error(e.message); process.exit(1); });
