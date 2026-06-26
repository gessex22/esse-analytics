import { db } from '../db/database';

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
console.log('tables:', tables);

const filesCount = db.prepare('SELECT COUNT(*) as n FROM files').get();
console.log('files count:', filesCount);

const pvCount = db.prepare('SELECT COUNT(*) as n FROM platform_videos').get();
console.log('platform_videos count:', pvCount);

const rows = db.prepare(`
  SELECT pv.id, pv.platform, pv.platform_id, pv.title, pv.linked_file_id, f.file_name
  FROM platform_videos pv
  LEFT JOIN files f ON f.id = pv.linked_file_id
  ORDER BY pv.created_at DESC
`).all();

console.log('platform_videos rows:', JSON.stringify(rows, null, 2));
