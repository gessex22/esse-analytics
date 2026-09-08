// Corrección puntual autorizada por el usuario: upload_history quedó con
// publishedAt="hoy" para el TikTok de "final - linux gaming.mp4" (BUG del
// 2026-09-07, ver docs/bug-reports.md) -- la fecha real es 2026-06-02,
// ya confirmada en PlatformVideoModel. Este script corrige solo ese campo,
// en ese único documento, identificado por platform+platformId exactos.
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

for (const line of fs.readFileSync(path.join(__dirname, '../../.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI as string);
  const db = mongoose.connection.db!;

  const filter = { platform: 'tiktok', platformId: '7646592511003135263' };
  const before = await db.collection('upload_history').findOne(filter);
  console.log('antes:', before?.publishedAt);

  const result = await db.collection('upload_history').updateOne(
    filter,
    { $set: { publishedAt: new Date('2026-06-02T02:00:00.000Z') } },
  );
  console.log('matched/modified:', result.matchedCount, result.modifiedCount);

  const after = await db.collection('upload_history').findOne(filter);
  console.log('despues:', after?.publishedAt);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
