import { MongoClient } from 'mongodb';
import fs from 'fs';

const MONGO_URI = process.env.MONGO_URI!;

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');
  const col = db.collection('files');

  const total = await col.countDocuments();
  const withPath = await col.countDocuments({ file_path: { $exists: true, $ne: '' } });
  const withUser = await col.countDocuments({ userId: { $exists: true, $ne: null } });

  console.log(`Total files en Mongo (central): ${total}`);
  console.log(`  con file_path: ${withPath}`);
  console.log(`  con userId:    ${withUser}`);

  // Muestra 8 rutas recientes y verifica si existen en este disco
  const sample = await col.find({ file_path: { $exists: true, $ne: '' } })
    .sort({ _id: -1 }).limit(8).toArray();

  console.log('\nMuestra de rutas (¿existen en este disco?):');
  let exists = 0;
  for (const f of sample) {
    const p = f.file_path as string;
    const ok = (() => { try { return fs.existsSync(p); } catch { return false; } })();
    if (ok) exists++;
    console.log(`  [${ok ? '✓' : '✗'}] ${p}`);
  }

  // Chequeo amplio: de TODOS los que tienen path, cuántos existen realmente
  const all = await col.find({ file_path: { $exists: true, $ne: '' } }, { projection: { file_path: 1 } }).toArray();
  let existAll = 0;
  for (const f of all) {
    try { if (fs.existsSync(f.file_path as string)) existAll++; } catch {}
  }
  console.log(`\nDe ${all.length} rutas en Mongo, existen en disco: ${existAll}`);

  await client.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
