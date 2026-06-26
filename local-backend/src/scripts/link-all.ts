import { db } from '../db/database';

db.prepare(`UPDATE platform_videos SET linked_file_id=383, match_status='manual', updated_at=datetime('now') WHERE platform='instagram'`).run();
db.prepare(`UPDATE platform_videos SET linked_file_id=373, match_status='manual', updated_at=datetime('now') WHERE platform='youtube'`).run();

const rows = db.prepare(`
  SELECT pv.platform, pv.platform_id, pv.title, f.file_name
  FROM platform_videos pv
  LEFT JOIN files f ON f.id = pv.linked_file_id
`).all();
console.log(JSON.stringify(rows, null, 2));
