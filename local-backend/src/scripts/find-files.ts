import { db } from '../db/database';

const terms = ['ban a antropic', 'applicaciones instantaneas', 'ban', 'antropic', 'applicaciones', 'instantaneas'];
for (const t of terms) {
  const rows = db.prepare(`SELECT id, file_name FROM files WHERE file_name LIKE ? LIMIT 3`).all(`%${t}%`);
  if (rows.length) console.log(`"${t}":`, rows);
}
