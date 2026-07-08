/**
 * Publica UN reel en el IG del owner (contenedor + subida normalizada + publish).
 * Uso: npx tsx --env-file=.env src/scripts/_publish-ig.ts "<videoPath>" "<captionFile>"
 */
import { MongoClient } from 'mongodb';
import fs from 'fs';
import https from 'https';

const FB_GRAPH = 'https://graph.facebook.com/v22.0';
const OWNER_ID = '6a3794fb81e6fb54aca72461';

async function igPost(path: string, body: Record<string, any>): Promise<any> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.append(k, String(v));
  const res = await fetch(`${FB_GRAPH}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  return res.json();
}
async function igGet(path: string, token: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  return (await fetch(`${FB_GRAPH}${path}${sep}access_token=${token}`)).json();
}
function uploadBuffer(uri: string, token: string, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(uri);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`, offset: '0', file_size: String(buffer.length),
        'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length),
      },
    }, (inc) => {
      let raw = ''; inc.on('data', c => (raw += c));
      inc.on('end', () => { console.log(`  upload ${inc.statusCode}: ${raw}`); (inc.statusCode ?? 0) >= 400 ? reject(new Error('upload fail')) : resolve(); });
    });
    req.on('error', reject); req.end(buffer);
  });
}

async function main() {
  const videoPath = process.argv[2];
  const caption = fs.readFileSync(process.argv[3], 'utf8').trim();
  const buffer = fs.readFileSync(videoPath);

  const client = new MongoClient(process.env.MONGO_URI!);
  await client.connect();
  const tok = await client.db().collection('oauth_tokens').findOne({ provider: 'instagram', userId: OWNER_ID });
  const token = tok!.access_token as string, igId = tok!.instagram_user_id as string;
  console.log('Video:', videoPath, `(${(buffer.length / 1e6).toFixed(1)} MB) | caption ${caption.length} chars`);

  const c = await igPost(`/${igId}/media`, { media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: true, access_token: token });
  console.log('contenedor:', JSON.stringify(c));
  if (!c.uri) process.exit(1);

  console.log('subiendo…'); await uploadBuffer(c.uri, token, buffer);

  let sc = 'IN_PROGRESS';
  for (let i = 0; i < 40 && sc === 'IN_PROGRESS'; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await igGet(`/${c.id}?fields=status_code,status`, token);
    sc = st.status_code ?? 'IN_PROGRESS';
    console.log(`  estado: ${sc}`);
    if (sc === 'ERROR') { console.error('ERROR:', st.status); process.exit(1); }
  }
  if (sc !== 'FINISHED') { console.error('no llegó a FINISHED'); process.exit(1); }

  console.log('publicando…');
  const pub = await igPost(`/${igId}/media_publish`, { creation_id: c.id, access_token: token });
  console.log('publish:', JSON.stringify(pub));
  if (pub.id) {
    const media = await igGet(`/${pub.id}?fields=permalink`, token);
    console.log('✓ PUBLICADO:', media.permalink);
  }
  await client.close();
}
main();
