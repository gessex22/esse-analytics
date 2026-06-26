import { db } from '../db/database';

db.prepare(`
  UPDATE platform_videos
  SET platform_id  = 'nIJzMFfvQlE',
      platform_url = 'https://www.youtube.com/watch?v=nIJzMFfvQlE',
      title        = 'MAC NEO abre 100 aplicaciones al INSTANTE',
      published_at = '2026-06-24T00:00:00.000Z',
      updated_at   = datetime('now')
  WHERE platform = 'youtube'
`).run();

const row = db.prepare(`
  SELECT pv.*, f.file_name FROM platform_videos pv
  LEFT JOIN files f ON f.id = pv.linked_file_id
  WHERE pv.platform = 'youtube'
`).get();
console.log('YouTube updated:', JSON.stringify(row, null, 2));
