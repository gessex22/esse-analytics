import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
dotenv.config();

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
const DB_PATH  = process.env.SQLITE_PATH || path.join(os.homedir(), '.esse-analytics', 'esse_local.db');
const JWT      = process.env.JWT || '';

if (!JWT) { console.error('Falta JWT. Uso: JWT=<token> npx tsx src/scripts/pull-to-sqlite.ts'); process.exit(1); }

async function main() {
  const res = await fetch(`${CENTRAL}/api/backup/files`, { headers: { Authorization: `Bearer ${JWT}` } });
  if (!res.ok) { console.error(`Error central (${res.status}):`, await res.text()); process.exit(1); }
  const { files }: { files: any[] } = await res.json();
  console.log(`backup_files: ${files.length}`);

  const db = new Database(DB_PATH);
  try { db.exec(`ALTER TABLE files ADD COLUMN tipo_contenido TEXT`); } catch {}

  const stmt = db.prepare(`UPDATE files SET tipo_contenido=?, platforms=?, platforms_discarded=?, updated_at=datetime('now') WHERE file_name=?`);
  let updated=0, notFound=0;
  for (const cf of files) {
    const r = stmt.run(cf.tipo_contenido ?? null, JSON.stringify(cf.platforms ?? []), JSON.stringify(cf.platforms_discarded ?? []), cf.file_name);
    if (r.changes > 0) updated++; else notFound++;
  }
  console.log(`✓ Actualizados: ${updated}  Sin match: ${notFound}`);
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
