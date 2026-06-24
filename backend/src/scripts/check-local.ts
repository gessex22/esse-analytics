import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGO_URI || '');
const db = mongoose.connection.db!;

const total      = await db.collection('files').countDocuments();
const activos    = await db.collection('files').countDocuments({ status: { $ne: 'ELIMINADO_DISCO' } });
const vertical   = await db.collection('files').countDocuments({ formato: 'VERTICAL', status: { $ne: 'ELIMINADO_DISCO' } });
const conTranscr = await db.collection('transcripts').countDocuments();

console.log('\n── Archivos locales ──────────────────────');
console.log(`  Total registros        : ${total}`);
console.log(`  Activos (no eliminados): ${activos}`);
console.log(`  Verticales             : ${vertical}`);
console.log(`  Con transcripción      : ${conTranscr}`);
console.log(`  Shorts YT en BD        : 126`);
console.log('──────────────────────────────────────────\n');

await mongoose.disconnect();
