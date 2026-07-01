// Recupera `platforms` (perdido por el bug del push destructivo del re-escaneo)
// usando los booleanos de `publishing_status` (youtube_published/instagram_published/
// tiktok_published). Esta colección es un snapshot de una fecha puntual, NO el
// historial real evolutivo — así que solo se aplica a archivos que HOY están vacíos,
// nunca pisa un archivo que ya tenga platforms (evita repetir el mismo error).
//
// Por defecto corre en DRY RUN (no escribe nada). Pasar --apply para escribir de verdad.
//
// Uso:
//   npx tsx src/scripts/recover-platforms-from-publishing-status.ts [username] [--apply]
import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI!;
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const USERNAME = args.find(a => !a.startsWith('--')) || 'esse';

function platformsFromStatus(ps: any): string[] {
  const p: string[] = [];
  if (ps.youtube_published)   p.push('youtube');
  if (ps.instagram_published) p.push('instagram');
  if (ps.tiktok_published)    p.push('tiktok');
  return p;
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('renders_manager');

  const user = await db.collection('users').findOne({ username: USERNAME.toLowerCase() });
  if (!user) { console.error(`Usuario "${USERNAME}" no encontrado.`); process.exit(1); }
  const userId = user._id.toString();
  console.log(`Usuario: ${USERNAME} (${userId})`);
  console.log(APPLY ? 'MODO: APPLY (va a escribir)' : 'MODO: DRY RUN (no escribe nada, pasá --apply para aplicar)');

  const statuses = await db.collection('publishing_status').find({}).toArray();
  console.log(`publishing_status total (todas las cuentas): ${statuses.length}`);

  let updatedFiles = 0, updatedBackup = 0, skippedHadData = 0, skippedEmptyStatus = 0, noMatch = 0;
  const plan: any[] = [];

  for (const ps of statuses) {
    const file = await db.collection('files').findOne({ _id: new ObjectId(ps.fileId), userId });
    if (!file) { noMatch++; continue; }

    // No pisar si el archivo YA tiene platforms (evita repetir el mismo error de hoy).
    if (Array.isArray(file.platforms) && file.platforms.length > 0) { skippedHadData++; continue; }

    const platforms = platformsFromStatus(ps);
    if (platforms.length === 0) { skippedEmptyStatus++; continue; }

    plan.push({ file_name: file.file_name, platforms });

    if (APPLY) {
      await db.collection('files').updateOne(
        { _id: file._id },
        { $set: { platforms } },
      );
      updatedFiles++;

      await db.collection('backup_files').updateOne(
        { userId, file_name: file.file_name },
        { $set: { platforms } },
        { upsert: false }, // si no existe backup_files para ese archivo, no lo creamos acá
      );
      updatedBackup++;
    }
  }

  console.log('\n=== Resultado ===');
  console.log({ paraAplicar: plan.length, updatedFiles, updatedBackup, skippedHadData, skippedEmptyStatus, noMatch });
  if (!APPLY && plan.length > 0) {
    console.log('\nMuestra de lo que se aplicaría (primeros 10):');
    console.log(JSON.stringify(plan.slice(0, 10), null, 2));
  }

  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
