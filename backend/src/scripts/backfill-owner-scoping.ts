import dotenv from 'dotenv';
dotenv.config();
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI!;
const OWNER_ID = '6a3794fb81e6fb54aca72461'; // esse (owner)
const DRY = process.argv.includes('--dry');

async function backfillCollection(col: any, name: string) {
  const before = await col.countDocuments({ $or: [{ userId: { $exists: false } }, { userId: null }] });
  console.log(`${name} sin dueño: ${before}`);
  if (DRY) return;
  const res = await col.updateMany(
    { $or: [{ userId: { $exists: false } }, { userId: null }] },
    { $set: { userId: OWNER_ID } },
  );
  console.log(`✓ ${name} asignados a esse: ${res.modifiedCount}`);
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');

  await backfillCollection(db.collection('ideas_centrales'), 'ideas_centrales');
  await backfillCollection(db.collection('publishing_status'), 'publishing_status');
  await backfillCollection(db.collection('platformvideos'), 'platformvideos');

  // platformvideos: el índice único legado era {platform, platformId}; el schema
  // nuevo usa {userId, platform, platformId}. Sin dropear el viejo, Mongo lo sigue
  // aplicando y rompe upserts legítimos entre usuarios distintos con el mismo video.
  const pvCol = db.collection('platformvideos');
  const indexes = await pvCol.indexes();
  const legacy = indexes.find((i: any) => JSON.stringify(i.key) === JSON.stringify({ platform: 1, platformId: 1 }));
  console.log(legacy ? `Índice legado encontrado: ${legacy.name}` : 'Índice legado {platform,platformId} no encontrado.');
  if (DRY) { await client.close(); return; }
  if (legacy) {
    await pvCol.dropIndex(legacy.name);
    console.log(`✓ Índice legado dropeado: ${legacy.name}`);
  }
  await pvCol.createIndex({ userId: 1, platform: 1, platformId: 1 }, { unique: true });
  console.log('✓ Índice nuevo {userId,platform,platformId} asegurado.');

  await client.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
