import { db } from '../db/database';

// Check platform_videos without linked file
const unlinked = db.prepare(
  `SELECT id, platform, title FROM platform_videos WHERE linked_file_id IS NULL`
).all() as { id: number; platform: string; title: string | null }[];

console.log('Unlinked platform_videos:', unlinked);

// Try to find matching files by title keywords
for (const pv of unlinked) {
  if (!pv.title) continue;
  // Get first meaningful word(s) from title for fuzzy match
  const words = pv.title.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
  console.log(`\n[${pv.platform}] Searching for: "${words.join(' ')}"`);

  for (const word of words) {
    const matches = db.prepare(
      `SELECT id, file_name FROM files WHERE file_name LIKE ? LIMIT 5`
    ).all(`%${word}%`) as { id: number; file_name: string }[];
    if (matches.length > 0) {
      console.log(`  Matches for "${word}":`, matches.map(m => `${m.id}: ${m.file_name}`));
    }
  }
}
