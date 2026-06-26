/**
 * seed-backup-from-files.ts
 * Migración de una sola vez: copia todos los documentos de la colección `files`
 * hacia `backup_files`, usando file_name como clave de deduplicación.
 *
 * Uso:
 *   cd backend
 *   npx tsx src/scripts/seed-backup-from-files.ts [--user <userId>]
 *
 * Si no se pasa --user, busca el userId del usuario cuyo username coincide con
 * OWNER_USERNAME (variable de entorno) o 'esse' por defecto.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { BackupFileModel } from '../models/backup-file.model';
import { UserModel } from '../models/user.model';

dotenv.config();

const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'esse').toLowerCase();

async function main() {
  await mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 });
  console.log('Conectado a MongoDB');

  // Determinar userId
  const uidArgIdx = process.argv.indexOf('--user');
  let userId: string;

  if (uidArgIdx !== -1 && process.argv[uidArgIdx + 1]) {
    userId = process.argv[uidArgIdx + 1];
  } else {
    const user = await UserModel.findOne({ username: OWNER_USERNAME }).lean();
    if (!user) {
      console.error(`Usuario '${OWNER_USERNAME}' no encontrado. Usa --user <id>`);
      process.exit(1);
    }
    userId = String(user._id);
  }

  console.log(`UserId: ${userId}`);

  // Leer todos los files
  const files = await FileModel.find({}).lean();
  console.log(`Files en MongoDB: ${files.length}`);

  if (files.length === 0) {
    console.log('No hay files que migrar.');
    process.exit(0);
  }

  // Bulk upsert a backup_files
  const ops = files.map(f => ({
    updateOne: {
      filter: { userId, file_name: f.file_name },
      update: {
        $setOnInsert: { userId, file_name: f.file_name },
        $set: {
          platforms:           f.platforms           ?? [],
          platforms_discarded: f.platforms_discarded ?? [],
          content_status:      f.content_status      ?? 'borrador',
          scheduled_date:      f.scheduled_date      ?? null,
          duracion_segundos:   f.duracion_segundos   ?? null,
          resolucion:          f.resolucion          ?? null,
          formato:             f.formato             ?? null,
          fecha_creacion:      f.fecha_creacion      ?? null,
          local_updated_at:    (f as any).updatedAt ?? new Date(),
        },
      },
      upsert: true,
    },
  }));

  const result = await BackupFileModel.bulkWrite(ops);
  console.log(`Upserted: ${result.upsertedCount}  Modificados: ${result.modifiedCount}  Total: ${files.length}`);
  console.log('✓ backup_files poblado. Ahora puedes usar Bajar desde la gema.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
