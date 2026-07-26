import { db } from './database';

export type MatchStatus = 'auto' | 'manual' | 'remote' | 'sin_match';

export interface GroupStatsCandidate {
  fileId: number;
  fileName: string;
  fechaCreacion: string | null;
  platforms: Record<string, { platformId: string; platformUrl: string | null; title: string | null }>;
}

export interface DbPlatformVideo {
  id: number;
  platform: string;
  platform_id: string;
  platform_url?: string;
  device_id?: string;
  source?: string;
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
  device_id: string | null;
  source: string | null;
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
    device_id:       row.device_id ?? undefined,
    source:          row.source ?? undefined,
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

  // Link de UNA plataforma puntual para un archivo — a diferencia de findLinkedToFile
  // (que trae cualquier fila sin filtrar plataforma), esto es lo que hace falta para
  // editar el link de YouTube/Instagram/TikTok de un video de forma independiente.
  findByFileAndPlatform(fileId: number | string, platform: string): DbPlatformVideo | undefined {
    const row = db.prepare(
      'SELECT * FROM platform_videos WHERE linked_file_id = ? AND platform = ?'
    ).get(Number(fileId), platform) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  // Desvincula (sin borrar el registro) — se usa al limpiar manualmente un link
  // desde la vista de Videos.
  unlinkFromFile(fileId: number | string, platform: string): void {
    db.prepare(
      `UPDATE platform_videos SET linked_file_id = NULL, updated_at = datetime('now')
       WHERE linked_file_id = ? AND platform = ?`
    ).run(Number(fileId), platform);
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
    device_id?: string;
    source?: string;
  }): DbPlatformVideo {
    const existing = this.findByPlatformAndId(data.platform, data.platform_id);
    const publishedAt = data.published_at ? new Date(data.published_at).toISOString() : null;
    const linkedFileId = data.linked_file_id ? Number(data.linked_file_id) : null;
    const matchStatus = data.match_status ?? 'sin_match';

    if (!existing) {
      db.prepare(`
        INSERT INTO platform_videos (platform, platform_id, platform_url, published_at, linked_file_id, match_status, title, description, device_id, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(data.platform, data.platform_id, data.platform_url ?? null, publishedAt, linkedFileId, matchStatus, data.title ?? null, data.description ?? null, data.device_id ?? null, data.source ?? null);
    } else {
      db.prepare(`
        UPDATE platform_videos
        SET platform_url = ?, published_at = ?, linked_file_id = ?, match_status = ?,
            title = COALESCE(?, title), description = COALESCE(?, description),
            device_id = COALESCE(?, device_id), source = COALESCE(?, source),
            updated_at = datetime('now')
        WHERE platform = ? AND platform_id = ?
      `).run(data.platform_url ?? existing.platform_url ?? null, publishedAt ?? existing.published_at ?? null,
             linkedFileId ?? existing.linked_file_id ?? null, matchStatus,
             data.title ?? null, data.description ?? null, data.device_id ?? null, data.source ?? null,
             data.platform, data.platform_id);
    }

    return this.findByPlatformAndId(data.platform, data.platform_id)!;
  },

  deleteAll(): number {
    return db.prepare('DELETE FROM platform_videos').run().changes;
  },

  findAll(): DbPlatformVideo[] {
    return (db.prepare('SELECT * FROM platform_videos').all() as RawRow[]).map(parse);
  },

  // Registro cronológico de subidas (todas las plataformas, o filtrado a una),
  // con el nombre del archivo local vinculado. Ordenado por fecha de publicación
  // (que es el momento real de la subida para lo hecho desde la app) con
  // created_at como respaldo para filas sin published_at.
  findHistory(opts: { limit: number; offset: number; platform?: string }): (DbPlatformVideo & { file_name?: string })[] {
    const where = opts.platform ? 'WHERE pv.platform = ?' : '';
    const params = opts.platform ? [opts.platform, opts.limit, opts.offset] : [opts.limit, opts.offset];
    const rows = db.prepare(`
      SELECT pv.*, f.file_name AS file_name
      FROM platform_videos pv
      LEFT JOIN files f ON f.id = pv.linked_file_id
      ${where}
      ORDER BY COALESCE(pv.published_at, pv.created_at) DESC
      LIMIT ? OFFSET ?
    `).all(...params) as (RawRow & { file_name: string | null })[];
    return rows.map((row) => {
      const { file_name, ...raw } = row;
      return { ...parse(raw), file_name: file_name ?? undefined };
    });
  },

  countHistory(platform?: string): number {
    const where = platform ? 'WHERE platform = ?' : '';
    const row = db.prepare(`SELECT COUNT(*) AS c FROM platform_videos ${where}`)
      .get(...(platform ? [platform] : [])) as { c: number };
    return row.c;
  },

  // Para Estadísticas: archivos con las 3 plataformas marcadas en files.platforms
  // (la señal confiable — sobrevive wipes/pulls), más recientes primero. platform_videos
  // solo se usa para enriquecer con el platform_id real de cada una (lo que hace falta
  // para pedirle stats en vivo a la central) — se completa lo que haya, aunque falte
  // el link de alguna: exigir las 3 YA linkeadas acá dejaba afuera todo lo publicado
  // desde esta misma app sin pasar por el cross-match central (que no corre solo).
  findGroupStatsCandidates(limit: number): GroupStatsCandidate[] {
    const fileRows = db.prepare(`
      SELECT id, file_name, fecha_creacion, platforms
      FROM files
      ORDER BY fecha_creacion DESC
    `).all() as { id: number; file_name: string; fecha_creacion: string | null; platforms: string }[];

    const pvRows = db.prepare(`
      SELECT platform, platform_id, platform_url, title, linked_file_id
      FROM platform_videos
      WHERE linked_file_id IS NOT NULL AND platform IN ('youtube', 'instagram', 'tiktok')
    `).all() as { platform: string; platform_id: string; platform_url: string | null; title: string | null; linked_file_id: number }[];
    const pvByFile = new Map<number, typeof pvRows>();
    for (const pv of pvRows) pvByFile.set(pv.linked_file_id, [...(pvByFile.get(pv.linked_file_id) ?? []), pv]);

    const result: GroupStatsCandidate[] = [];
    for (const f of fileRows) {
      if (result.length >= limit) break;
      let badges: string[];
      try { badges = JSON.parse(f.platforms || '[]'); } catch { badges = []; }
      if (!['youtube', 'instagram', 'tiktok'].every(p => badges.includes(p))) continue;

      const platforms: Record<string, { platformId: string; platformUrl: string | null; title: string | null }> = {};
      for (const pv of pvByFile.get(f.id) ?? []) {
        platforms[pv.platform] = { platformId: pv.platform_id, platformUrl: pv.platform_url, title: pv.title };
      }
      // Un badge manual sin vínculo real no debe entrar en Estadísticas: no
      // existe un platformId al que pedirle métricas y produciría tarjetas con
      // ceros que parecen datos válidos. El matching manual es el que completa
      // estos tres registros.
      if (!['youtube', 'instagram', 'tiktok'].every(p => platforms[p]?.platformId)) continue;
      result.push({ fileId: f.id, fileName: f.file_name, fechaCreacion: f.fecha_creacion, platforms });
    }
    return result;
  },
};
