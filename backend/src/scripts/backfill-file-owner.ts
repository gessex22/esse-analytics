import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI!;
const OWNER_ID = '6a3794fb81e6fb54aca72461'; // esse (owner)

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');
  const col = db.collection('files');

  const before = await col.countDocuments({ $or: [{ userId: { $exists: false } }, { userId: null }] });
  console.log(`Archivos sin dueño: ${before}`);

  const res = await col.updateMany(
    { $or: [{ userId: { $exists: false } }, { userId: null }] },
    { $set: { userId: OWNER_ID } },
  );
  console.log(`✓ Asignados a esse: ${res.modifiedCount}`);

  const total = await col.countDocuments();
  const owned = await col.countDocuments({ userId: OWNER_ID });
  console.log(`Total: ${total} | de esse: ${owned}`);

  await client.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
