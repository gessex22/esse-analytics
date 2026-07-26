import { db } from '../db/database';

const platforms = ['youtube', 'instagram', 'tiktok'] as const;

type FileRow = {
  id: number;
  file_name: string;
  platforms: string;
  platforms_discarded: string;
};

const files = db.prepare(`
  SELECT id, file_name, platforms, platforms_discarded
  FROM files
`).all() as FileRow[];

let repaired = 0;
let publishedWithoutUrl = 0;

const update = db.prepare(`
  UPDATE files
  SET platforms = ?, platforms_discarded = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const reconcile = db.transaction(() => {
  for (const file of files) {
    let current: string[] = [];
    let discarded: string[] = [];
    try { current = JSON.parse(file.platforms || '[]'); } catch { /* legacy row */ }
    try { discarded = JSON.parse(file.platforms_discarded || '[]'); } catch { /* legacy row */ }

    const linked = db.prepare(`
      SELECT platform, platform_url
      FROM platform_videos
      WHERE linked_file_id = ?
        AND platform IN ('youtube', 'instagram', 'tiktok')
    `).all(file.id) as { platform: string; platform_url: string | null }[];

    const next = new Set(current.filter(platform => platforms.includes(platform as typeof platforms[number])));
    const nextDiscarded = new Set(discarded.filter(platform => platforms.includes(platform as typeof platforms[number])));

    for (const row of linked) {
      // Un ID/publication sin URL sigue siendo una publicación válida. Nunca
      // escribimos un espacio falso: el URL queda NULL/vacío y el badge se
      // conserva por el estado de publicación.
      if (!row.platform_url?.trim()) publishedWithoutUrl++;
      next.add(row.platform);
      nextDiscarded.delete(row.platform);
    }

    const nextPlatforms = [...next];
    const nextDiscardedArray = [...nextDiscarded];
    if (JSON.stringify(nextPlatforms) !== JSON.stringify(current) || JSON.stringify(nextDiscardedArray) !== JSON.stringify(discarded)) {
      update.run(JSON.stringify(nextPlatforms), JSON.stringify(nextDiscardedArray), file.id);
      repaired++;
    }
  }
});

reconcile();
console.log(`[badges] archivos reparados: ${repaired}`);
console.log(`[badges] publicaciones sin URL conservadas: ${publishedWithoutUrl}`);

