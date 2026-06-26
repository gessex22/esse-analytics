import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db!;

  const configs = await db.collection('platform_config').find({}).toArray();

  if (configs.length === 0) {
    console.log('No hay registros en platform_config.');
    await mongoose.disconnect();
    return;
  }

  for (const c of configs) {
    console.log(`\n=== ${String(c.platform).toUpperCase()} ===`);
    console.log(`  Último publicado : ${c.lastPublishedTitle ?? '—'}`);
    console.log(`  Fecha último     : ${c.lastPublishedDate ?? '—'}`);
    console.log(`  Intervalo días   : ${c.intervalDays ?? '—'}`);

    if (c.lastVideoId) {
      try {
        const f = await FileModel.findById(c.lastVideoId).select('file_name').lean();
        console.log(`  Actual (archivo) : ${f?.file_name ?? '⚠ no encontrado'}`);
      } catch {
        console.log(`  Actual (archivo) : ⚠ ID inválido (${c.lastVideoId})`);
      }
    } else {
      console.log(`  Actual (archivo) : (no seteado)`);
    }

    if (c.nextVideoId) {
      try {
        const f = await FileModel.findById(c.nextVideoId).select('file_name').lean();
        console.log(`  Próximo (archivo): ${f?.file_name ?? '⚠ no encontrado'}`);
      } catch {
        console.log(`  Próximo (archivo): ⚠ ID inválido (${c.nextVideoId})`);
      }
    } else {
      console.log(`  Próximo (archivo): (no seteado)`);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
