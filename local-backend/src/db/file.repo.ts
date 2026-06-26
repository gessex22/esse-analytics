import { db } from './database';

export type FileStatus = 'PENDIENTE' | 'PROCESANDO' | 'TRANSCRITO' | 'ELIMINADO_DISCO' | 'ERROR';
export type FileContentStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado';
export type Platform = 'youtube' | 'instagram' | 'tiktok';

export interface DbFile {
  id: number;
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
    }
    // Sin filtro de content_status → muestra todo (la fuente de verdad son los arrays de platforms)

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

  findSlim(limit: number): { id: number; file_name: string; duracion_segundos: number | null }[] {
    return db.prepare(
      `SELECT id, file_name, duracion_segundos FROM files
       WHERE status != 'ELIMINADO_DISCO'
       ORDER BY COALESCE(fecha_creacion, created_at) DESC LIMIT ?`
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
        (file_name, file_path, status, content_status, platforms, platforms_discarded, duracion_segundos, resolucion, formato, fecha_creacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    if ('fecha_creacion' in data)           setStr('fecha_creacion', data.fecha_creacion ? new Date(data.fecha_creacion!).toISOString() : null);
    if ('scheduled_date' in data)           setStr('scheduled_date', data.scheduled_date ? new Date(data.scheduled_date!).toISOString() : null);

    params.push(Number(id));
    const info = db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return info.changes > 0;
  },

  addPlatform(id: number | string, platform: Platform): void {
    const file = this.findById(id);
    if (!file) return;
    if (!file.platforms.includes(platform)) {
      this.update(id, { platforms: [...file.platforms, platform] });
    }
  },

  countAll(): number {
    return (db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number }).cnt;
  },
};
