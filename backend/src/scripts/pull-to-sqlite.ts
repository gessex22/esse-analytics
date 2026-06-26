/**
 * pull-to-sqlite.ts
 * Lee backup_files de MongoDB y sincroniza tipo_contenido + platforms directamente al SQLite local.
 * No requiere JWT ni que el local-backend esté corriendo.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { BackupFileModel } from '../models/backup-file.model';
import { UserModel } from '../models/user.model';

dotenv.config();

const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'esse').toLowerCase();
const DB_PATH = process.env.SQLITE_PATH || path.join(os.homedir(), '.esse-analytics', 'esse_local.db');

async function main() {
  await mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 });
  console.log('MongoDB conectado');

  const user = await UserModel.findOne({ username: OWNER_USERNAME }).lean();
  if (!user) { console.error(`Usuario '${OWNER_USERNAME}' no encontrado`); process.exit(1); }
  const userId = String(user._id);

  const cloudFiles = await BackupFileModel.find({ userId }).lean();
  console.log(`backup_files en cloud: ${cloudFiles.length}`);

  const db = new Database(DB_PATH);
  console.log(`SQLite: ${DB_PATH}`);

  // Ensure columns exist
  try { db.exec(`ALTER TABLE files ADD COLUMN tipo_contenido TEXT`); } catch {}

  const update = db.prepare(`
    UPDATE files SET tipo_contenido = ?, platforms = ?, platforms_discarded = ?, updated_at = datetime('now')
    WHERE file_name = ? AND (tipo_contenido IS NULL OR tipo_contenido != ?)
  `);

  let updated = 0, skipped = 0;
  for (const cf of cloudFiles) {
    const result = update.run(
      cf.tipo_contenido ?? null,
      JSON.stringify(cf.platforms ?? []),
      JSON.stringify(cf.platforms_discarded ?? []),
      cf.file_name,
      cf.tipo_contenido ?? null,
    );
    if (result.changes > 0) updated++; else skipped++;
  }

  console.log(`✓ Actualizados: ${updated}  Sin cambio: ${skipped}`);
  db.close();
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
