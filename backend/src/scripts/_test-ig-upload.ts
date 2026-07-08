/**
 * Diagnóstico de subida resumable CHUNKED a Meta (NO publica).
 * Uso: npx tsx --env-file=.env src/scripts/_test-ig-upload.ts "<videoPath>" [chunkMB]
 */
import { MongoClient } from 'mongodb';
import fs from 'fs';
import https from 'https';

const FB_GRAPH = 'https://graph.facebook.com/v22.0';
const OWNER_ID = '6a3794fb81e6fb54aca72461';
const CHUNK = (Number(process.argv[3]) || 25) * 1024 * 1024;

async function igPost(path: string, body: Record<string, any>): Promise<any> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.append(k, String(v));
  const res = await fetch(`${FB_GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return res.json();
}

function postChunk(uri: string, token: string, chunk: Buffer, offset: number, fileSize: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(uri);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        Authorization:    `OAuth ${token}`,
        offset:           String(offset),
        file_size:        String(fileSize),
        'Content-Type':   'application/octet-stream',
        'Content-Length': String(chunk.length),
      },
    }, (incoming) => {
      let raw = '';
      incoming.on('data', c => (raw += c));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: raw }));
    });
    req.on('error', reject);
    req.end(chunk);
  });
}

async function main() {
  const videoPath = process.argv[2];
  if (!videoPath || !fs.existsSync(videoPath)) { console.error('Ruta inválida'); process.exit(1); }

  const client = new MongoClient(process.env.MONGO_URI!);
  await client.connect();
  const tok = await client.db().collection('oauth_tokens').findOne({ provider: 'instagram', userId: OWNER_ID });
  const token = tok!.access_token as string, igId = tok!.instagram_user_id as string;

  const buffer = fs.readFileSync(videoPath);
  console.log('Video:', videoPath, `(${(buffer.length / 1e6).toFixed(1)} MB) | chunk ${(CHUNK / 1e6).toFixed(0)} MB`);

  const c = await igPost(`/${igId}/media`, {
    media_type: 'REELS', upload_type: 'resumable', caption: 'diag', share_to_feed: true, access_token: token,
  });
  console.log('contenedor:', JSON.stringify(c));
  if (!c.uri) process.exit(1);

  let offset = 0, chunkN = 0;
  while (offset < buffer.length) {
    const slice = buffer.subarray(offset, Math.min(offset + CHUNK, buffer.length));
    const r = await postChunk(c.uri, token, slice, offset, buffer.length);
    chunkN++;
    console.log(`  chunk ${chunkN} offset=${offset} len=${slice.length} → ${r.status}: ${r.body.slice(0, 120)}`);
    if (r.status >= 400) { console.error('✗ chunk falló'); break; }
    offset += slice.length;
  }

  console.log('Estado (8s)…');
  await new Promise(r => setTimeout(r, 8000));
  const st = await (await fetch(`${FB_GRAPH}/${c.id}?fields=status_code,status&access_token=${token}`)).json();
  console.log(' ', JSON.stringify(st));

  await client.close();
}
main();
