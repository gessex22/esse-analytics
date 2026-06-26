import { db } from '../db/database';

// Link YouTube "El caos de discord" to final-discord.mp4 (id 766)
db.prepare(`
  UPDATE platform_videos
  SET linked_file_id = 766, match_status = 'auto', updated_at = datetime('now')
  WHERE platform = 'youtube' AND platform_id = 'G0WcpyUPRKM'
`).run();

const row = db.prepare(`
  SELECT pv.*, f.file_name
  FROM platform_videos pv
  LEFT JOIN files f ON f.id = pv.linked_file_id
  WHERE pv.platform = 'youtube'
`).get();
console.log('YouTube record after update:', JSON.stringify(row, null, 2));
