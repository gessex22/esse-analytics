import { db } from './database';

export type MatchStatus = 'auto' | 'manual' | 'remote' | 'sin_match';

export interface DbPlatformVideo {
  id: number;
  platform: string;
  platform_id: string;
  platform_url?: string;
  published_at?: string;
  linked_file_id?: number;
  match_status: MatchStatus;
  title?: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

interface RawRow {
  id: number;
  platform: string;
  platform_id: string;
  platform_url: string | null;
  published_at: string | null;
  linked_file_id: number | null;
  match_status: string;
  title: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function parse(row: RawRow): DbPlatformVideo {
  return {
    ...row,
    platform_url:    row.platform_url ?? undefined,
    published_at:    row.published_at ?? undefined,
    linked_file_id:  row.linked_file_id ?? undefined,
    match_status:    row.match_status as MatchStatus,
    title:           row.title ?? undefined,
    description:     row.description ?? undefined,
  };
}

export const platformVideoRepo = {
  findByPlatformAndId(platform: string, platformId: string): DbPlatformVideo | undefined {
    const row = db.prepare(
      'SELECT * FROM platform_videos WHERE platform = ? AND platform_id = ?'
    ).get(platform, platformId) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  findLinkedToFile(fileId: number | string): DbPlatformVideo | undefined {
    const row = db.prepare(
      'SELECT * FROM platform_videos WHERE linked_file_id = ?'
    ).get(Number(fileId)) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  // For calendar: YouTube videos sorted by published_at DESC, with a linked file
  findByPlatformLinked(platform: string, limit: number): DbPlatformVideo[] {
    return (db.prepare(
      `SELECT * FROM platform_videos
       WHERE platform = ? AND linked_file_id IS NOT NULL AND published_at IS NOT NULL
       ORDER BY published_at DESC LIMIT ?`
    ).all(platform, limit) as RawRow[]).map(parse);
  },

  // Latest published video for a platform joined with the local file name (may be null)
  findLatestWithFileName(platform: string): (DbPlatformVideo & { file_name?: string }) | undefined {
    const row = db.prepare(
      `SELECT pv.*, f.file_name AS file_name
       FROM platform_videos pv
       LEFT JOIN files f ON f.id = pv.linked_file_id
       WHERE pv.platform = ? AND pv.published_at IS NOT NULL
       ORDER BY pv.published_at DESC LIMIT 1`
    ).get(platform) as (RawRow & { file_name: string | null }) | undefined;
    if (!row) return undefined;
    const { file_name, ...raw } = row;
    return { ...parse(raw), file_name: file_name ?? undefined };
  },

  upsert(data: {
    platform: string;
    platform_id: string;
    platform_url?: string;
    published_at?: string | Date;
    linked_file_id?: number | string;
    match_status?: MatchStatus;
    title?: string;
    description?: string;
  }): DbPlatformVideo {
    const existing = this.findByPlatformAndId(data.platform, data.platform_id);
    const publishedAt = data.published_at ? new Date(data.published_at).toISOString() : null;
    const linkedFileId = data.linked_file_id ? Number(data.linked_file_id) : null;
    const matchStatus = data.match_status ?? 'sin_match';

    if (!existing) {
      db.prepare(`
        INSERT INTO platform_videos (platform, platform_id, platform_url, published_at, linked_file_id, match_status, title, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(data.platform, data.platform_id, data.platform_url ?? null, publishedAt, linkedFileId, matchStatus, data.title ?? null, data.description ?? null);
    } else {
      db.prepare(`
        UPDATE platform_videos
        SET platform_url = ?, published_at = ?, linked_file_id = ?, match_status = ?,
            title = COALESCE(?, title), description = COALESCE(?, description),
            updated_at = datetime('now')
        WHERE platform = ? AND platform_id = ?
      `).run(data.platform_url ?? existing.platform_url ?? null, publishedAt ?? existing.published_at ?? null,
             linkedFileId ?? existing.linked_file_id ?? null, matchStatus,
             data.title ?? null, data.description ?? null,
             data.platform, data.platform_id);
    }

    return this.findByPlatformAndId(data.platform, data.platform_id)!;
  },

  deleteAll(): number {
    return db.prepare('DELETE FROM platform_videos').run().changes;
  },
};
