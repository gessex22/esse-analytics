import 'dotenv/config';
import mongoose from 'mongoose';
import { applyPlatformPublish } from '../controllers/backup.controller';

// Re-aplica el fix de BUG-2026-09-06-02 para "final - linux gaming.mp4" tras
// confirmar que un push de la PC lo revirtió ~30s después (BUG-2026-09-06-04,
// ya corregido en bulkUpsertBackupFiles) -- reusa applyPlatformPublish (mismo
// codepath revisado del backfill), no un update directo a mano.
const USER_ID = '6a3794fb81e6fb54aca72461';

async function main() {
  await mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 });
  const result = await applyPlatformPublish(USER_ID, {
    platform: 'instagram',
    platformId: '18620794828002948',
    platformUrl: 'https://www.instagram.com/reel/Dc6gxfKpKBi',
    fileName: 'final - linux gaming.mp4',
    contentId: '8837744b-3c6f-449c-8fcc-0aef8c179133',
    remoteLibraryVideoId: '6a5f3234e4c2c52866c6da0c',
    publishedAt: new Date('2026-09-05T17:44:54.000Z'),
    matchStatus: 'manual',
  });
  console.log(result);
  const file = await mongoose.connection.db!.collection('files').findOne(
    { content_id: '8837744b-3c6f-449c-8fcc-0aef8c179133' },
    { projection: { platforms: 1, platforms_discarded: 1, platform_states: 1 } },
  );
  console.log(JSON.stringify(file, null, 2));
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
