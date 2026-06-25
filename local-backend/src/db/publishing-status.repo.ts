import { db } from './database';

export interface DbPublishingStatus {
  id: number;
  file_id: number;
  title: string;
  tiktok_published: boolean;
  instagram_published: boolean;
  youtube_published: boolean;
  created_at: string;
  // joined from files
  fecha_creacion?: string;
}

interface RawRow {
  id: number;
  file_id: number;
  title: string;
  tiktok_published: number;
  instagram_published: number;
  youtube_published: number;
  created_at: string;
  fecha_creacion: string | null;
}

function parse(row: RawRow): DbPublishingStatus {
  return {
    ...row,
    tiktok_published:    Boolean(row.tiktok_published),
    instagram_published: Boolean(row.instagram_published),
    youtube_published:   Boolean(row.youtube_published),
    fecha_creacion: row.fecha_creacion ?? undefined,
  };
}

export const publishingStatusRepo = {
  findAll(): DbPublishingStatus[] {
    const rows = db.prepare(`
      SELECT ps.*, f.fecha_creacion
      FROM publishing_status ps
      LEFT JOIN files f ON f.id = ps.file_id
      ORDER BY COALESCE(f.fecha_creacion, ps.created_at) DESC
    `).all() as RawRow[];
    return rows.map(parse);
  },

  findByFileId(fileId: number | string): DbPublishingStatus | undefined {
    const row = db.prepare(`
      SELECT ps.*, f.fecha_creacion
      FROM publishing_status ps
      LEFT JOIN files f ON f.id = ps.file_id
      WHERE ps.file_id = ?
    `).get(Number(fileId)) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  upsert(fileId: number | string, title: string, updates: Partial<{
    tiktok_published: boolean;
    instagram_published: boolean;
    youtube_published: boolean;
  }>): DbPublishingStatus {
    const id = Number(fileId);
    const existing = this.findByFileId(id);

    if (!existing) {
      db.prepare(`
        INSERT INTO publishing_status (file_id, title, tiktok_published, instagram_published, youtube_published)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        id, title,
        Number(updates.tiktok_published ?? false),
        Number(updates.instagram_published ?? false),
        Number(updates.youtube_published ?? false),
      );
    } else {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (updates.tiktok_published !== undefined)    { sets.push('tiktok_published = ?');    params.push(Number(updates.tiktok_published)); }
      if (updates.instagram_published !== undefined) { sets.push('instagram_published = ?'); params.push(Number(updates.instagram_published)); }
      if (updates.youtube_published !== undefined)   { sets.push('youtube_published = ?');   params.push(Number(updates.youtube_published)); }
      if (sets.length) {
        params.push(id);
        db.prepare(`UPDATE publishing_status SET ${sets.join(', ')} WHERE file_id = ?`).run(...params);
      }
    }

    return this.findByFileId(id)!;
  },

  deleteByFileId(fileId: number | string): void {
    db.prepare('DELETE FROM publishing_status WHERE file_id = ?').run(Number(fileId));
  },

  deleteAll(): number {
    return db.prepare('DELETE FROM publishing_status').run().changes;
  },
};
