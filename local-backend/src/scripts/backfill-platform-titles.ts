/**
 * Backfill title column in platform_videos from linked file_name
 * Run once: npx tsx src/scripts/backfill-platform-titles.ts
 */
import { db } from '../db/database';

const rows = db.prepare(`
  SELECT pv.id, pv.platform, pv.platform_id, pv.title, f.file_name
  FROM platform_videos pv
  LEFT JOIN files f ON f.id = pv.linked_file_id
  WHERE pv.title IS NULL AND f.file_name IS NOT NULL
`).all() as { id: number; platform: string; platform_id: string; title: string | null; file_name: string }[];

if (rows.length === 0) {
  console.log('Nada que actualizar — todos ya tienen title o no tienen archivo vinculado.');
} else {
  for (const row of rows) {
    db.prepare(`UPDATE platform_videos SET title = ? WHERE id = ?`).run(row.file_name, row.id);
    console.log(`✓ [${row.platform}] ${row.platform_id.slice(0, 30)}... → title="${row.file_name}"`);
  }
  console.log(`\n✅ Actualizados ${rows.length} registro(s).`);
}
