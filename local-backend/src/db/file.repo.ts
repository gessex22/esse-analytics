import { db } from './database';
import { randomUUID } from 'crypto';

export type FileStatus = 'PENDIENTE' | 'PROCESANDO' | 'TRANSCRITO' | 'ELIMINADO_DISCO' | 'ERROR';
export type FileContentStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado';
export type Platform = 'youtube' | 'instagram' | 'tiktok' | 'facebook';

export interface DbFile {
  id: number;
  content_id: string;
  file_name: string;
  file_path: string;
  status: FileStatus;
  content_status: FileContentStatus;
  platforms: Platform[];
  platforms_discarded: Platform[];
  tipo_contenido?: string;
  duracion_segundos?: number;
  resolucion?: string;
  formato?: string;
  fecha_creacion?: string;
  scheduled_date?: string;
  created_at: string;
  updated_at: string;
}

interface RawRow {
  id: number;
  content_id: string | null;
  file_name: string;
  file_path: string;
  status: string;
  content_status: string;
  platforms: string;
  platforms_discarded: string;
  tipo_contenido: string | null;
  duracion_segundos: number | null;
  resolucion: string | null;
  formato: string | null;
  fecha_creacion: string | null;
  scheduled_date: string | null;
  created_at: string;
  updated_at: string;
}

function parse(row: RawRow): DbFile {
  return {
    ...row,
    platforms:            JSON.parse(row.platforms            || '[]'),
    platforms_discarded:  JSON.parse(row.platforms_discarded  || '[]'),
    tipo_contenido:    row.tipo_contenido    ?? undefined,
    duracion_segundos: row.duracion_segundos ?? undefined,
    resolucion: row.resolucion ?? undefined,
    formato: row.formato ?? undefined,
    fecha_creacion: row.fecha_creacion ?? undefined,
    scheduled_date: row.scheduled_date ?? undefined,
  } as DbFile;
}

export const fileRepo = {
  findById(id: number | string): DbFile | undefined {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(id)) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  findByPath(filePath: string): DbFile | undefined {
    const row = db.prepare('SELECT * FROM files WHERE file_path = ?').get(filePath) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  findByName(fileName: string): DbFile | undefined {
    const row = db.prepare('SELECT * FROM files WHERE file_name = ? LIMIT 1').get(fileName) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  findByContentId(contentId: string): DbFile | undefined {
    const row = db.prepare('SELECT * FROM files WHERE content_id = ? LIMIT 1').get(contentId) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  /**
   * El primer video MÁS NUEVO que el dado (por fecha_creacion) que TODAVÍA no
   * está resuelto (ni publicado ni descartado) para `platform`. Es "el
   * siguiente" en la secuencia de publicación de ESA plataforma puntual --
   * antes tomaba directo el archivo inmediatamente adyacente sin mirar su
   * estado, así que si ese archivo (o varios seguidos) ya estaban publicados
   * en `platform` por otra vía (ej. publicado directo desde el celular sin
   * pasar por acá), el calendario quedaba pegado mostrando como "próximo" un
   * video que en realidad ya salió.
   */
  findNewerAdjacent(file: DbFile, platform: Platform): DbFile | undefined {
    const ref = file.fecha_creacion ?? file.created_at;
    const row = db.prepare(`
      SELECT * FROM files
      WHERE status != 'ELIMINADO_DISCO'
        AND content_status != 'descartado'
        AND id != ?
        AND COALESCE(fecha_creacion, created_at) > ?
        AND NOT EXISTS (SELECT 1 FROM json_each(platforms) WHERE json_each.value = ?)
        AND NOT EXISTS (SELECT 1 FROM json_each(platforms_discarded) WHERE json_each.value = ?)
      ORDER BY COALESCE(fecha_creacion, created_at) ASC, id ASC
      LIMIT 1
    `).get(file.id, ref, platform, platform) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  findAll(opts: {
    status?: string;
    content_status?: string;
    tipo?: string;
    search?: string;
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
    excludeStatus?: string;
  } = {}): { rows: DbFile[]; total: number } {
    const conds: string[] = [];
    const params: unknown[] = [];

    if (opts.search)        { conds.push('file_name LIKE ?'); params.push(`%${opts.search}%`); }
    if (opts.status)        { conds.push('status = ?'); params.push(opts.status); }
    if (opts.excludeStatus) { conds.push('status != ?'); params.push(opts.excludeStatus); }
    if (opts.tipo)          { conds.push('tipo_contenido = ?'); params.push(opts.tipo); }
    if (opts.content_status === 'sin_publicar') {
      // Ninguna plataforma publicada ni descartada
      conds.push(`json_array_length(platforms) = 0 AND json_array_length(platforms_discarded) = 0`);
    } else if (opts.content_status === 'parcial') {
      // Publicado en ≥1 plataforma pero al menos una sigue pendiente
      conds.push(`json_array_length(platforms) > 0 AND json_array_length(platforms) + json_array_length(platforms_discarded) < 3`);
    } else if (opts.content_status === 'completo') {
      // Las 3 plataformas tienen estado definitivo (publicado o descartado)
      conds.push(`json_array_length(platforms) + json_array_length(platforms_discarded) = 3`);
    } else if (opts.content_status === 'no_completo') {
      // Default de la vista principal: oculta los que ya están completos en las 3 plataformas
      conds.push(`json_array_length(platforms) + json_array_length(platforms_discarded) < 3`);
    }
    // Sin filtro de content_status → muestra todo, incluidos los completos (usado por scan/backup/watcher)

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const dir = opts.order === 'asc' ? 'ASC' : 'DESC';
    const orderBy = `ORDER BY COALESCE(fecha_creacion, created_at) ${dir}, id ${dir}`;

    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM files ${where}`).get(...params) as { cnt: number };
    const total = countRow.cnt;

    let dataSql = `SELECT * FROM files ${where} ${orderBy}`;
    const dataParams = [...params];
    if (opts.limit !== undefined) { dataSql += ' LIMIT ?'; dataParams.push(opts.limit); }
    if (opts.offset !== undefined) { dataSql += ' OFFSET ?'; dataParams.push(opts.offset); }

    const rows = (db.prepare(dataSql).all(...dataParams) as RawRow[]).map(parse);
    return { rows, total };
  },

  findSlim(limit: number): { id: number; file_name: string; file_path: string; duracion_segundos: number | null; platforms: Platform[]; platforms_discarded: Platform[] }[] {
    const rows = db.prepare(
      `SELECT id, file_name, file_path, duracion_segundos, platforms, platforms_discarded FROM files
       WHERE status != 'ELIMINADO_DISCO'
       ORDER BY COALESCE(fecha_creacion, created_at) DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(r => ({
      ...r,
      platforms:           JSON.parse(r.platforms           || '[]'),
      platforms_discarded: JSON.parse(r.platforms_discarded || '[]'),
    }));
  },

  // Para GET /api/calendar?year=&month= (Dashboard + Calendario) — mirror de
  // getCalendarVideos en backend/src/controllers/video.controller.ts, pero
  // local: nunca existió acá, así que la llamada caía en el catch-all de la
  // SPA (devolvía index.html) y JSON.parse tumbaba el Promise.all del
  // Dashboard entero -- ver DashboardView.tsx. effective_date replica el
  // $ifNull encadenado de Mongo (scheduled_date > fecha_creacion > created_at);
  // la comparación de rango funciona por orden lexicográfico porque ambos
  // formatos (ISO con 'T' y "YYYY-MM-DD HH:MM:SS") arrancan con el mismo
  // prefijo de fecha.
  findForCalendar(year: number, month: number): {
    id: number; file_name: string; content_status: string; platforms: string;
    tipo_contenido: string | null; duracion_segundos: number | null;
    scheduled_date: string | null; effective_date: string;
  }[] {
    const pad = (n: number) => String(n).padStart(2, '0');
    const start = `${year}-${pad(month)}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear  = month === 12 ? year + 1 : year;
    const end = `${nextYear}-${pad(nextMonth)}-01`;

    return db.prepare(`
      SELECT id, file_name, content_status, platforms, tipo_contenido, duracion_segundos, scheduled_date,
             COALESCE(scheduled_date, fecha_creacion, created_at) AS effective_date
      FROM files
      WHERE status != 'ELIMINADO_DISCO'
        AND (content_status IS NULL OR content_status != 'descartado')
        AND COALESCE(scheduled_date, fecha_creacion, created_at) >= ?
        AND COALESCE(scheduled_date, fecha_creacion, created_at) <  ?
      ORDER BY effective_date ASC
    `).all(start, end) as any[];
  },

  /** Igual que findSlim pero solo los que todavía no están clasificados — evita que
   * el plugin de transcripción tenga que preguntar archivo por archivo (era N+1).
   * Se filtra por tipo_contenido (no por "tiene fila en transcripts"): un video
   * puede tener una transcripción restaurada desde el backup en la nube (pull de
   * transcripts o de ideas centrales, que nunca cargan tipo_contenido) sin haber
   * sido clasificado nunca — si filtráramos por la fila de transcripts, ese video
   * quedaba marcado "ya transcrito" y jamás se re-encolaba para clasificarlo,
   * mostrando "Contenido" para siempre en vez de Guión/Random/Sin Voz. */
  findSlimPendingTranscript(limit: number): { id: number; file_name: string; file_path: string; duracion_segundos: number | null }[] {
    return db.prepare(
      `SELECT f.id, f.file_name, f.file_path, f.duracion_segundos
       FROM files f
       WHERE f.status != 'ELIMINADO_DISCO' AND f.tipo_contenido IS NULL
       ORDER BY COALESCE(f.fecha_creacion, f.created_at) DESC LIMIT ?`
    ).all(limit) as any[];
  },

  create(data: {
    file_name: string;
    file_path: string;
    status?: FileStatus;
    content_status?: FileContentStatus;
    platforms?: Platform[];
    platforms_discarded?: Platform[];
    duracion_segundos?: number;
    resolucion?: string;
    formato?: string;
    fecha_creacion?: string | Date | null;
  }): DbFile {
    const info = db.prepare(`
      INSERT INTO files
        (content_id, file_name, file_path, status, content_status, platforms, platforms_discarded, duracion_segundos, resolucion, formato, fecha_creacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      data.file_name,
      data.file_path,
      data.status ?? 'PENDIENTE',
      data.content_status ?? 'borrador',
      JSON.stringify(data.platforms ?? []),
      JSON.stringify(data.platforms_discarded ?? []),
      data.duracion_segundos ?? null,
      data.resolucion ?? null,
      data.formato ?? null,
      data.fecha_creacion ? new Date(data.fecha_creacion).toISOString() : null,
    );
    return this.findById(info.lastInsertRowid as number)!;
  },

  update(id: number | string, data: Partial<{
    file_name: string;
    file_path: string;
    status: FileStatus;
    content_status: FileContentStatus;
    platforms: Platform[];
    platforms_discarded: Platform[];
    tipo_contenido: string | null;
    duracion_segundos: number;
    resolucion: string;
    formato: string;
    fecha_creacion: string | Date | null;
    scheduled_date: string | Date | null;
  }>): boolean {
    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    const setStr = (col: string, val: unknown) => { sets.push(`${col} = ?`); params.push(val); };

    if (data.file_name !== undefined)       setStr('file_name', data.file_name);
    if (data.file_path !== undefined)       setStr('file_path', data.file_path);
    if (data.status !== undefined)          setStr('status', data.status);
    if (data.content_status !== undefined)      setStr('content_status', data.content_status);
    if (data.platforms !== undefined)           setStr('platforms', JSON.stringify(data.platforms));
    if (data.platforms_discarded !== undefined) setStr('platforms_discarded', JSON.stringify(data.platforms_discarded));
    if ('tipo_contenido' in data)              setStr('tipo_contenido', data.tipo_contenido ?? null);
    if (data.duracion_segundos !== undefined) setStr('duracion_segundos', data.duracion_segundos);
    if (data.resolucion !== undefined)        setStr('resolucion', data.resolucion);
    if (data.formato !== undefined)           setStr('formato', data.formato);
    if ('fecha_creacion' in data)           setStr('fecha_creacion', data.fecha_creacion ? new Date(data.fecha_creacion!).toISOString() : null);
    if ('scheduled_date' in data)           setStr('scheduled_date', data.scheduled_date ? new Date(data.scheduled_date!).toISOString() : null);

    params.push(Number(id));
    const info = db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return info.changes > 0;
  },

  addPlatform(id: number | string, platform: Platform): void {
    const file = this.findById(id);
    if (!file) return;
    const platforms = file.platforms.includes(platform) ? file.platforms : [...file.platforms, platform];
    // Una subida real siempre gana: si la plataforma había quedado marcada como
    // descartada (p.ej. por el auto-descarte del flujo simple), sacarla de ahí.
    const platforms_discarded = file.platforms_discarded.includes(platform)
      ? file.platforms_discarded.filter(p => p !== platform)
      : file.platforms_discarded;
    if (platforms !== file.platforms || platforms_discarded !== file.platforms_discarded) {
      this.update(id, { platforms, platforms_discarded });
    }
  },

  // Contraparte de addPlatform — se usa al borrar manualmente el link de una
  // plataforma desde Videos (vuelve a "pendiente", no la marca como descartada).
  removePlatform(id: number | string, platform: Platform): void {
    const file = this.findById(id);
    if (!file || !file.platforms.includes(platform)) return;
    this.update(id, { platforms: file.platforms.filter(p => p !== platform) });
  },

  /**
   * Flujo simple: al publicar de verdad en una plataforma, las demás que sigan
   * "pendientes" (nunca tocadas para este video) se resuelven como descartadas.
   * Así la cola de esa plataforma avanza al siguiente video en vez de quedarse
   * esperando que este mismo se termine de publicar en todas partes. Si alguna
   * ya estaba resuelta (publicada o descartada a propósito) no se toca.
   */
  resolveOthersAsDiscarded(id: number | string, published: Platform): void {
    const file = this.findById(id);
    if (!file) return;
    const others: Platform[] = (['youtube', 'instagram', 'tiktok'] as Platform[]).filter(p => p !== published);
    const stillPending = others.filter(p => !file.platforms.includes(p) && !file.platforms_discarded.includes(p));
    if (stillPending.length === 0) return;
    this.update(id, { platforms_discarded: [...file.platforms_discarded, ...stillPending] });
  },

  /**
   * Próximo video a publicar en una plataforma: el MÁS RECIENTE que todavía no está
   * publicado ahí (ni descartado para esa plataforma, ni borrado del disco, ni descartado global).
   * Es la fuente de verdad del "video por defecto" en la vista de subir y del calendario.
   * Avanza solo: al publicar uno, queda excluido y aparece el siguiente en la cola.
   * ASC (el más VIEJO pendiente primero), no DESC -- antes agarraba el más
   * nuevo, así que un video recién grabado se colaba delante de meses de
   * backlog real (videos ya publicados en otra plataforma, esperando esta).
   * Mismo criterio que ya asumía PublishingQueue.tsx en el frontend cuando no
   * hay nextVideoId confiable ("el default es el pendiente más VIEJO").
   */
  findNextUnpublished(platform: Platform): DbFile | undefined {
    const row = db.prepare(`
      SELECT * FROM files
      WHERE status != 'ELIMINADO_DISCO'
        AND content_status != 'descartado'
        AND NOT EXISTS (SELECT 1 FROM json_each(platforms)           WHERE value = ?)
        AND NOT EXISTS (SELECT 1 FROM json_each(platforms_discarded) WHERE value = ?)
      ORDER BY COALESCE(fecha_creacion, created_at) ASC, id ASC
      LIMIT 1
    `).get(platform, platform) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  // Contraparte de findNextUnpublished: el archivo más reciente que SÍ tiene el
  // badge de esta plataforma. Se usa como respaldo del "último publicado" del
  // calendario -- platform_videos (el que trae el platformId/url exactos) es un
  // espejo que se vacía en cada wipe de logout y solo se repuebla parcial vía
  // backup_platform_videos (mucho más flaco que files.platforms, que sí sobrevive
  // completo el ciclo push/pull). Sin esto, el calendario perdía la referencia al
  // video físico real apenas ese espejo quedaba desactualizado.
  findLatestPublished(platform: Platform): DbFile | undefined {
    const row = db.prepare(`
      SELECT * FROM files
      WHERE status != 'ELIMINADO_DISCO'
        AND EXISTS (SELECT 1 FROM json_each(platforms) WHERE value = ?)
      ORDER BY COALESCE(fecha_creacion, created_at) DESC, id DESC
      LIMIT 1
    `).get(platform) as RawRow | undefined;
    return row ? parse(row) : undefined;
  },

  countAll(): number {
    return (db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number }).cnt;
  },
};
