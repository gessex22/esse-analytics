import { db } from './database';

export type IdeaRol = 'POR_DEFECTO' | 'RELACIONADO' | 'SUGERENCIA_BORRAR';
export type IdeaStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado';

export interface DbIdea {
  id: number;
  idea_nucleo: string;
  resumen_visual: string;
  status: IdeaStatus;
  video_principal_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface DbIdeaVideo {
  id: number;
  idea_id: number;
  file_id: number;
  similitud_guion: number;
  rol: IdeaRol;
  file_name: string;
  file_path: string;
  duracion_segundos: number | null;
  resolucion: string | null;
  formato: string | null;
  fecha_creacion: string | null;
  created_at: string;
}

function formatDuration(s: number | null): string {
  if (!s) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function videosByIdea(ideaId: number): DbIdeaVideo[] {
  return db.prepare(`
    SELECT iv.*, f.file_name, f.file_path, f.duracion_segundos, f.resolucion, f.formato, f.fecha_creacion
    FROM idea_videos iv
    JOIN files f ON f.id = iv.file_id
    WHERE iv.idea_id = ?
    ORDER BY iv.similitud_guion DESC, iv.created_at ASC
  `).all(ideaId) as DbIdeaVideo[];
}

function mapVideoForFrontend(v: DbIdeaVideo) {
  return {
    id:       String(v.file_id),
    name:     v.file_name,
    duration: formatDuration(v.duracion_segundos),
    format:   v.formato ?? 'HORIZONTAL',
    fecha:    v.fecha_creacion ?? v.created_at,
  };
}

export const ideaRepo = {
  findAllWithVideos(tipo?: string): any[] {
    // Orden por la fecha real del video principal (no por updated_at de la idea, que
    // para las ideas migradas en bloque queda casi idéntico entre sí y no dice nada).
    const ideas = db.prepare(`
      SELECT i.* FROM ideas_centrales i
      LEFT JOIN files f ON f.id = i.video_principal_id
      ORDER BY COALESCE(f.fecha_creacion, f.created_at, i.updated_at) DESC, i.id DESC
    `).all() as DbIdea[];

    return ideas
      .map(idea => {
        const videos = videosByIdea(idea.id);
        if (tipo) {
          // Filtra por tipo_contenido del video principal (coherente con cómo VideosView filtra).
          const principal = videos.find(v => v.file_id === idea.video_principal_id);
          const row = principal ? db.prepare('SELECT tipo_contenido FROM files WHERE id = ?').get(principal.file_id) as { tipo_contenido: string | null } | undefined : undefined;
          if (row?.tipo_contenido !== tipo) return null;
        }
        const videoPrincipal = videos.find(v => v.file_id === idea.video_principal_id) ?? videos[0] ?? null;
        const versionesPrevias = videos.filter(v => v.file_id !== (videoPrincipal?.file_id));

        return {
          _id:              String(idea.id),
          title:            (idea.resumen_visual || idea.idea_nucleo || 'Idea sin título').slice(0, 60),
          status:           idea.status,
          idea_nucleo:      idea.idea_nucleo,
          videoPrincipal:   videoPrincipal ? mapVideoForFrontend(videoPrincipal) : null,
          versionesPrevias: versionesPrevias.map(mapVideoForFrontend),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  },

  findById(id: number | string): DbIdea | undefined {
    return db.prepare('SELECT * FROM ideas_centrales WHERE id = ?').get(Number(id)) as DbIdea | undefined;
  },

  /** Ids de archivos que ya pertenecen a alguna idea (para no re-agrupar). */
  clusteredFileIds(): Set<number> {
    const rows = db.prepare('SELECT DISTINCT file_id FROM idea_videos').all() as { file_id: number }[];
    return new Set(rows.map(r => r.file_id));
  },

  listIdeaCores(): { id: number; idea_nucleo: string }[] {
    return db.prepare('SELECT id, idea_nucleo FROM ideas_centrales').all() as any[];
  },

  create(data: {
    idea_nucleo: string;
    resumen_visual: string;
    videos: { file_id: number; similitud_guion: number; rol: IdeaRol }[];
    video_principal_id: number;
  }): DbIdea {
    const insertIdea = db.prepare(`
      INSERT INTO ideas_centrales (idea_nucleo, resumen_visual, video_principal_id)
      VALUES (?, ?, ?)
    `);
    const insertVideo = db.prepare(`
      INSERT INTO idea_videos (idea_id, file_id, similitud_guion, rol)
      VALUES (?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      const info = insertIdea.run(data.idea_nucleo, data.resumen_visual, data.video_principal_id);
      const ideaId = info.lastInsertRowid as number;
      for (const v of data.videos) {
        insertVideo.run(ideaId, v.file_id, v.similitud_guion, v.rol);
      }
      return ideaId;
    });

    const ideaId = tx();
    return this.findById(ideaId)!;
  },

  addVideo(ideaId: number | string, video: { file_id: number; similitud_guion: number; rol: IdeaRol }): boolean {
    const idea = this.findById(ideaId);
    if (!idea) return false;
    db.prepare(`
      INSERT OR IGNORE INTO idea_videos (idea_id, file_id, similitud_guion, rol)
      VALUES (?, ?, ?, ?)
    `).run(Number(ideaId), video.file_id, video.similitud_guion, video.rol);
    db.prepare(`UPDATE ideas_centrales SET updated_at = datetime('now') WHERE id = ?`).run(Number(ideaId));
    return true;
  },

  setMainVersion(ideaId: number | string, fileId: number | string): boolean {
    const idea = this.findById(ideaId);
    if (!idea) return false;
    const belongs = db.prepare('SELECT 1 FROM idea_videos WHERE idea_id = ? AND file_id = ?').get(Number(ideaId), Number(fileId));
    if (!belongs) return false;

    const tx = db.transaction(() => {
      db.prepare(`UPDATE idea_videos SET rol = 'RELACIONADO' WHERE idea_id = ? AND rol = 'POR_DEFECTO'`).run(Number(ideaId));
      db.prepare(`UPDATE idea_videos SET rol = 'POR_DEFECTO' WHERE idea_id = ? AND file_id = ?`).run(Number(ideaId), Number(fileId));
      db.prepare(`UPDATE ideas_centrales SET video_principal_id = ?, updated_at = datetime('now') WHERE id = ?`).run(Number(fileId), Number(ideaId));
    });
    tx();
    return true;
  },

  updateStatus(ideaId: number | string, status: IdeaStatus): boolean {
    const info = db.prepare(`UPDATE ideas_centrales SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, Number(ideaId));
    return info.changes > 0;
  },

  /** Quita un video de la idea (no borra el archivo físico; eso lo maneja el controller). */
  removeVideo(ideaId: number | string, fileId: number | string): void {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM idea_videos WHERE idea_id = ? AND file_id = ?').run(Number(ideaId), Number(fileId));

      const remaining = videosByIdea(Number(ideaId));
      const idea = this.findById(ideaId)!;

      if (remaining.length === 0) {
        db.prepare(`UPDATE ideas_centrales SET video_principal_id = NULL, updated_at = datetime('now') WHERE id = ?`).run(Number(ideaId));
        return;
      }

      if (idea.video_principal_id === Number(fileId)) {
        // Promovemos el siguiente con mayor similitud a POR_DEFECTO.
        const next = remaining[0];
        db.prepare(`UPDATE idea_videos SET rol = 'POR_DEFECTO' WHERE idea_id = ? AND file_id = ?`).run(Number(ideaId), next.file_id);
        db.prepare(`UPDATE ideas_centrales SET video_principal_id = ?, updated_at = datetime('now') WHERE id = ?`).run(next.file_id, Number(ideaId));
      }
    });
    tx();
  },

  videosOf(ideaId: number | string): DbIdeaVideo[] {
    return videosByIdea(Number(ideaId));
  },

  delete(ideaId: number | string): void {
    db.prepare('DELETE FROM ideas_centrales WHERE id = ?').run(Number(ideaId));
  },

  /** Guiones transcritos que todavía no pertenecen a ninguna idea (candidatos para Maiden). */
  listUnclusteredGuiones(): { file_id: number; file_name: string; file_path: string; text: string; duracion_segundos: number | null; resolucion: string | null; formato: string | null; fecha_creacion: string | null; created_at: string }[] {
    return db.prepare(`
      SELECT f.id AS file_id, f.file_name, f.file_path, t.text, f.duracion_segundos, f.resolucion, f.formato, f.fecha_creacion, f.created_at
      FROM files f
      JOIN transcripts t ON t.file_id = f.id
      WHERE f.tipo_contenido = 'GUION_ESTRUCTURADO'
        AND f.id NOT IN (SELECT file_id FROM idea_videos)
      ORDER BY COALESCE(f.fecha_creacion, f.created_at) ASC
    `).all() as any[];
  },
};
