import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI!;
const OWNER_ID = '6a3794fb81e6fb54aca72461'; // esse

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');

  // 1) Backfill userId en platform_config y platformvideos
  const pc = await db.collection('platform_config').updateMany(
    { $or: [{ userId: { $exists: false } }, { userId: null }] },
    { $set: { userId: OWNER_ID } },
  );
  console.log(`platform_config asignados a esse: ${pc.modifiedCount}`);

  const pv = await db.collection('platformvideos').updateMany(
    { $or: [{ userId: { $exists: false } }, { userId: null }] },
    { $set: { userId: OWNER_ID } },
  );
  console.log(`platformvideos asignados a esse: ${pv.modifiedCount}`);

  // 2) Revisar índices de platform_config — un único en {platform} solo rompería el multi-usuario
  const idx = await db.collection('platform_config').indexes();
  console.log('\nÍndices platform_config:');
  for (const i of idx) console.log('  ', i.name, JSON.stringify(i.key), i.unique ? '(unique)' : '');

  // Si existe un índice único SOLO sobre {platform}, lo quitamos (ahora la clave es userId+platform)
  for (const i of idx) {
    const keys = Object.keys(i.key);
    if (i.unique && keys.length === 1 && keys[0] === 'platform') {
      await db.collection('platform_config').dropIndex(i.name);
      console.log(`  → eliminado índice único obsoleto: ${i.name}`);
    }
  }

  await client.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
