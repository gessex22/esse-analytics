import { db } from './database';

export type MatchStatus = 'auto' | 'manual' | 'remote' | 'sin_match';

export interface GroupStatsCandidate {
  fileId: number;
  fileName: string;
  fechaCreacion: string | null;
  // `rowId` = id real de la fila en platform_videos (no el fileId de arriba, que
  // para YouTube/Instagram/TikTok puede ser el id del archivo local vinculado).
  // Hace falta para poder persistir un platform_id resuelto más tarde sin crear
  // una fila nueva (ver resolvePendingLocalTikTokIds en sync.controller.ts).
  platforms: Record<string, { platformId: string; platformUrl: string | null; title: string | null; rowId?: number }>;
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

  // Actualiza el platform_id de una fila puntual PRESERVANDO su id (a diferencia
  // de upsert, que resuelve por platform+platform_id -- si se le pasa el nuevo id
  // ya resuelto, no encuentra la fila vieja y crea una fila nueva en vez de
  // corregir la existente). Se usa para persistir el id real de TikTok una vez
  // resuelto (ver resolvePendingLocalTikTokIds en sync.controller.ts) y que las
  // próximas consultas ya no dependan de volver a resolverlo en cada request.
  updatePlatformId(rowId: number, platformId: string): void {
    db.prepare(`UPDATE platform_videos SET platform_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(platformId, rowId);
  },

  deleteAll(): number {
    return db.prepare('DELETE FROM platform_videos').run().changes;
  },

  // Contraparte de deleteFileFromDisk (video.controller.ts): sin esto, borrar
  // un archivo dejaba sus filas de platform_videos huérfanas para siempre
  // (linked_file_id apuntando a un id que ya no existe en `files`).
  deleteByFileId(fileId: number | string): number {
    return db.prepare('DELETE FROM platform_videos WHERE linked_file_id = ?').run(Number(fileId)).changes;
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
  findGroupStatsCandidates(limit: number, platform?: 'youtube' | 'instagram' | 'tiktok'): GroupStatsCandidate[] {
    // En las pestañas individuales la fuente es el historial real de subidas,
    // no los archivos emparejados. Así se respetan los últimos publicados de
    // cada red, incluso cuando todavía no tienen las tres plataformas.
    if (platform) {
      // Se trae de más (varias veces `limit`) porque el mismo archivo puede tener
      // MÁS de una fila para esta plataforma (reintentos de subida, o un pull de
      // backup que trajo de vuelta un registro viejo con el publish_id crudo sin
      // resolver todavía) -- deduplicar ANTES del LIMIT evitaría que un archivo
      // duplicado le robe el lugar a videos realmente distintos.
      const rows = db.prepare(`
        SELECT pv.id, pv.platform, pv.platform_id, pv.platform_url, pv.title,
               pv.linked_file_id, COALESCE(pv.published_at, pv.created_at) AS published_at,
               f.file_name AS file_name
        FROM platform_videos pv
        LEFT JOIN files f ON f.id = pv.linked_file_id
        WHERE pv.platform = ? AND pv.platform_id != ''
          AND (f.id IS NULL OR f.status != 'ELIMINADO_DISCO')
        ORDER BY COALESCE(pv.published_at, pv.created_at) DESC
        LIMIT ?
      `).all(platform, limit * 4) as { id: number; platform: string; platform_id: string; platform_url: string | null; title: string | null; linked_file_id: number | null; published_at: string; file_name: string | null }[];

      // Un mismo archivo (linked_file_id) nunca debe aportar dos tarjetas: se
      // queda la fila con platform_id numérico (resuelto, con métricas reales)
      // por sobre una con publish_id/URL sin resolver -- y entre dos igual de
      // resueltas, la más reciente. Filas sin linked_file_id no tienen forma de
      // saber si son el mismo video, así que se dejan pasar tal cual (por su id).
      const isResolved = (id: string) => /^\d+$/.test(id);
      const byDedupeKey = new Map<string, typeof rows[number]>();
      for (const row of rows) {
        const key = row.linked_file_id != null ? `file:${row.linked_file_id}` : `row:${row.id}`;
        const prev = byDedupeKey.get(key);
        if (!prev) { byDedupeKey.set(key, row); continue; }
        const prevResolved = isResolved(prev.platform_id);
        const rowResolved = isResolved(row.platform_id);
        if (rowResolved && !prevResolved) byDedupeKey.set(key, row);
      }
      const deduped = [...byDedupeKey.values()]
        .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
        .slice(0, limit);

      return deduped.map(row => ({
        fileId: row.linked_file_id ?? row.id,
        fileName: row.file_name ?? row.title ?? row.platform_id,
        fechaCreacion: row.published_at,
        platforms: {
          [platform]: { platformId: row.platform_id, platformUrl: row.platform_url, title: row.title, rowId: row.id },
        },
      }));
    }

    const fileRows = db.prepare(`
      SELECT id, file_name, fecha_creacion, platforms
      FROM files
      WHERE status != 'ELIMINADO_DISCO'
      ORDER BY fecha_creacion DESC
    `).all() as { id: number; file_name: string; fecha_creacion: string | null; platforms: string }[];

    const pvRows = db.prepare(`
      SELECT id, platform, platform_id, platform_url, title, linked_file_id
      FROM platform_videos
      WHERE linked_file_id IS NOT NULL AND platform IN ('youtube', 'instagram', 'tiktok')
    `).all() as { id: number; platform: string; platform_id: string; platform_url: string | null; title: string | null; linked_file_id: number }[];
    const pvByFile = new Map<number, typeof pvRows>();
    for (const pv of pvRows) pvByFile.set(pv.linked_file_id, [...(pvByFile.get(pv.linked_file_id) ?? []), pv]);

    const result: GroupStatsCandidate[] = [];
    for (const f of fileRows) {
      if (result.length >= limit) break;
      let badges: string[];
      try { badges = JSON.parse(f.platforms || '[]'); } catch { badges = []; }
      if (!['youtube', 'instagram', 'tiktok'].every(p => badges.includes(p))) continue;

      // Igual que en la rama por plataforma: un archivo puede tener más de una
      // fila para la misma plataforma (reintentos, pull de backup con un registro
      // viejo) -- sin preferir la resuelta, la última insertada podía pisar a la
      // que sí tenía el platform_id numérico y dejar la tarjeta en cero.
      const platforms: Record<string, { platformId: string; platformUrl: string | null; title: string | null; rowId?: number }> = {};
      for (const pv of pvByFile.get(f.id) ?? []) {
        const current = platforms[pv.platform];
        if (current && /^\d+$/.test(current.platformId) && !/^\d+$/.test(pv.platform_id)) continue;
        platforms[pv.platform] = { platformId: pv.platform_id, platformUrl: pv.platform_url, title: pv.title, rowId: pv.id };
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
