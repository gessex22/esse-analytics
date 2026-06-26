/**
 * migrate-transcripts.ts
 * Trae los transcript_text desde MongoDB (vía central API) y los escribe en SQLite.
 *
 * Uso:
 *   JWT="<token>" npx tsx src/scripts/migrate-transcripts.ts
 *
 * Variables de entorno:
 *   JWT           — Bearer token del usuario (requerido)
 *   CENTRAL       — URL de la API central (default: https://api.esse-analytics.com)
 *   SQLITE_PATH   — Ruta al archivo esse_local.db
 *                   (default: AppData/Roaming/esse-analytics-desktop/esse_local.db)
 */

import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const JWT         = process.env.JWT         || '';
const CENTRAL     = process.env.CENTRAL     || 'https://api.esse-analytics.com';
const SQLITE_PATH = process.env.SQLITE_PATH ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'esse-analytics-desktop', 'esse_local.db');

if (!JWT) {
  console.error('Falta JWT=<token>');
  process.exit(1);
}

async function main() {
  console.log(`SQLite: ${SQLITE_PATH}`);
  console.log(`Central: ${CENTRAL}`);

  // Traer transcripts desde central
  const resp = await fetch(`${CENTRAL}/api/backup/transcripts`, {
    headers: { Authorization: `Bearer ${JWT}` },
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`Error de la central (${resp.status}):`, err.slice(0, 300));
    process.exit(1);
  }
  const { transcripts, total } = await resp.json() as {
    transcripts: { file_name: string; transcript_text: string; language: string }[];
    total: number;
  };
  console.log(`Transcripts en la nube: ${total}`);

  const db = new Database(SQLITE_PATH);

  // Índice file_name → id en SQLite
  const files = db.prepare('SELECT id, file_name FROM files').all() as { id: number; file_name: string }[];
  const idMap  = new Map(files.map(f => [f.file_name, f.id]));
  console.log(`Archivos en SQLite: ${files.length}`);

  const upsert = db.prepare(`
    INSERT INTO transcripts (file_id, text, language)
      VALUES (?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE
      SET text = excluded.text,
          language = excluded.language,
          updated_at = datetime('now')
  `);

  let matched = 0;
  let skipped = 0;

  const migrate = db.transaction(() => {
    for (const t of transcripts) {
      const fileId = idMap.get(t.file_name);
      if (!fileId) { skipped++; continue; }
      upsert.run(fileId, t.transcript_text, t.language || 'es');
      matched++;
    }
  });

  migrate();
  db.close();

  console.log(`✓ Migrados: ${matched}  Sin match: ${skipped}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
