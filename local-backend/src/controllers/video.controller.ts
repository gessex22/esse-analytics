import { Request, Response } from 'express';
import { fileRepo, FileContentStatus } from '../db/file.repo';
import { transcriptRepo } from '../db/transcript.repo';
import { publishingStatusRepo } from '../db/publishing-status.repo';
import { ensureThumbnail, deleteThumbnail, probeDuration } from '../services/thumbnail.service';
import fs from 'fs';
import path from 'path';

// ── GET /api/videos ───────────────────────────────────────────────────────────
export const getVideos = (req: Request, res: Response) => {
  const page   = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit  = Math.max(1, parseInt(req.query.limit as string) || 10);
  const offset = (page - 1) * limit;
  const { search, status, content_status, tipo, order } = req.query;

  const { rows, total } = fileRepo.findAll({
    search:         search as string | undefined,
    status:         status as string | undefined,
    // Sin filtro explícito del frontend → oculta por defecto los completos en las 3 plataformas
    content_status: (content_status as string | undefined) || 'no_completo',
    tipo:           tipo as string | undefined,
    order:          (order === 'asc' ? 'asc' : 'desc'),
    limit,
    offset,
  });

  const totalPages = Math.ceil(total / limit);

  res.json({
    info: {
      totalRecords: total,
      totalPages,
      currentPage:  page,
      nextPage:     page < totalPages ? page + 1 : null,
      prevPage:     page > 1 ? page - 1 : null,
    },
    results: rows.map(f => ({
      _id: String(f.id),
      file_id: {
        _id: String(f.id),
        file_name: f.file_name,
        file_path: f.file_path,
        status: f.status,
        content_status: f.content_status,
        duracion_segundos: f.duracion_segundos,
        resolucion: f.resolucion,
        formato: f.formato,
        fecha_creacion: f.fecha_creacion ?? f.created_at,
      },
      platforms: f.platforms,
      platforms_discarded: f.platforms_discarded,
      tipo_contenido: f.tipo_contenido ?? null,
      duracion_segundos: f.duracion_segundos,
      resolucion: f.resolucion,
      formato: f.formato,
      fecha_creacion: f.fecha_creacion ?? f.created_at,
    })),
  });
};

// ── GET /api/videos/slim ──────────────────────────────────────────────────────
export const getVideoSlimList = (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 1200, 2000);
  const files = fileRepo.findSlim(limit);
  res.json(files.map(f => ({
    fileId:    String(f.id),
    title:     f.file_name,
    filePath:  f.file_path,
    duration:  f.duracion_segundos ? formatDuration(f.duracion_segundos) : '',
    platforms: f.platforms,
    platforms_discarded: f.platforms_discarded,
  })));
};

// ── GET /api/videos/:fileId/thumbnail — miniatura generada con ffmpeg (local) ──
export const getVideoThumbnail = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const file = fileRepo.findById(fileId);
  if (!file || file.status === 'ELIMINADO_DISCO') { res.status(404).end(); return; }
  if (!fs.existsSync(file.file_path)) { res.status(404).end(); return; }

  const { path: thumb, probedDurationSec } = await ensureThumbnail(file.id, file.file_path, file.duracion_segundos ?? undefined);
  if (probedDurationSec) fileRepo.update(file.id, { duracion_segundos: probedDurationSec });
  if (!thumb) { res.status(404).end(); return; }

  // Le avisa al frontend la duración ya resuelta (propia o recién probada) para
  // que la fila se autocorrija sin esperar a recargar toda la lista de Videos.
  const durationSec = file.duracion_segundos || probedDurationSec || 0;
  if (durationSec) res.setHeader('X-Duration-Seconds', String(durationSec));

  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.resolve(thumb));
};

// ── GET /api/videos/slim/pending-transcript — usado por esse_transcrip.py ──────
// Filtra en un solo query los que ya tienen transcripción (antes el plugin
// preguntaba archivo por archivo: 1 request HTTP por video, muy lento con miles).
export const getVideoSlimPendingTranscript = (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 2000, 5000);
  const files = fileRepo.findSlimPendingTranscript(limit);
  res.json(files.map(f => ({
    fileId:    String(f.id),
    title:     f.file_name,
    filePath:  f.file_path,
    duration:  f.duracion_segundos ? formatDuration(f.duracion_segundos) : '',
  })));
};

// ── PATCH /api/videos/:fileId/status ─────────────────────────────────────────
export const updateVideoContentStatus = (req: Request, res: Response): void => {
  const { fileId } = req.params;
  const { status } = req.body as { status?: FileContentStatus };
  const valid: FileContentStatus[] = ['publicado', 'borrador', 'procesando', 'descartado'];
  if (!status || !valid.includes(status)) { res.status(400).json({ message: 'Estado inválido.' }); return; }

  const updated = fileRepo.update(fileId, { content_status: status });
  if (!updated) { res.status(404).json({ message: 'Archivo no encontrado.' }); return; }
  res.json({ content_status: status });
};

// ── PATCH /api/videos/:fileId/platforms ──────────────────────────────────────
export const updateVideoPlatforms = (req: Request, res: Response): void => {
  const { fileId } = req.params;
  const { platforms, platforms_discarded } = req.body as { platforms?: string[]; platforms_discarded?: string[] };
  const valid = ['youtube', 'instagram', 'tiktok', 'facebook'];
  if (!Array.isArray(platforms) || platforms.some(p => !valid.includes(p))) {
    res.status(400).json({ message: 'Plataformas inválidas.' }); return;
  }
  if (platforms_discarded !== undefined && (!Array.isArray(platforms_discarded) || platforms_discarded.some(p => !valid.includes(p)))) {
    res.status(400).json({ message: 'platforms_discarded inválido.' }); return;
  }
  const data: Parameters<typeof fileRepo.update>[1] = { platforms: platforms as any };
  if (platforms_discarded !== undefined) data.platforms_discarded = platforms_discarded as any;
  const updated = fileRepo.update(fileId, data);
  if (!updated) { res.status(404).json({ message: 'No encontrado.' }); return; }
  res.json({ platforms, platforms_discarded });
};

// ── PATCH /api/videos/bulk — edición masiva (plataformas y/o tipo de contenido) ─
export const updateVideosBulk = (req: Request, res: Response): void => {
  const { fileIds, platforms: targetPlatforms, platformState, tipo_contenido } = req.body as {
    fileIds?: string[];
    platforms?: string[];
    platformState?: 'publicado' | 'descartado' | 'pendiente';
    tipo_contenido?: string | null;
  };

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    res.status(400).json({ message: 'fileIds requerido.' }); return;
  }

  const validPlatforms = ['youtube', 'instagram', 'tiktok', 'facebook'];
  if (targetPlatforms !== undefined && (!Array.isArray(targetPlatforms) || targetPlatforms.some(p => !validPlatforms.includes(p)))) {
    res.status(400).json({ message: 'Plataformas inválidas.' }); return;
  }
  const validStates = ['publicado', 'descartado', 'pendiente'];
  if (platformState !== undefined && !validStates.includes(platformState)) {
    res.status(400).json({ message: 'Estado inválido.' }); return;
  }

  let updated = 0;
  for (const fileId of fileIds) {
    const file = fileRepo.findById(fileId);
    if (!file) continue;

    const data: Parameters<typeof fileRepo.update>[1] = {};

    if (targetPlatforms && targetPlatforms.length > 0 && platformState) {
      const ps = targetPlatforms as typeof file.platforms;
      const platforms = file.platforms.filter(x => !ps.includes(x));
      const discarded = file.platforms_discarded.filter(x => !ps.includes(x));
      if (platformState === 'publicado') platforms.push(...ps);
      else if (platformState === 'descartado') discarded.push(...ps);
      data.platforms = platforms;
      data.platforms_discarded = discarded;
    }

    if (tipo_contenido !== undefined) data.tipo_contenido = tipo_contenido;

    if (Object.keys(data).length > 0 && fileRepo.update(fileId, data)) updated++;
  }

  res.json({ updated });
};

// ── PATCH /api/videos/:fileId/rename ─────────────────────────────────────────
export const renameVideo = (req: Request, res: Response): void => {
  const { fileId } = req.params;
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ message: 'Nombre vacío.' }); return; }
  const cleanName = name.trim();

  const doc = fileRepo.findById(fileId);
  if (!doc) { res.status(404).json({ message: 'No encontrado.' }); return; }

  const oldPath = path.resolve(doc.file_path);
  const newPath = path.join(path.dirname(oldPath), cleanName + path.extname(oldPath));
  let diskRenamed = false;
  if (fs.existsSync(oldPath)) { fs.renameSync(oldPath, newPath); diskRenamed = true; }

  fileRepo.update(fileId, {
    file_name: cleanName,
    file_path: diskRenamed ? newPath : doc.file_path,
  });

  res.json({ file_name: cleanName, file_path: diskRenamed ? newPath : doc.file_path, disk_renamed: diskRenamed });
};

// ── DELETE /api/videos/:fileId/delete-file ────────────────────────────────────
export const deleteFileFromDisk = (req: Request, res: Response) => {
  const doc = fileRepo.findById(req.params.fileId);
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  if (doc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'Ya eliminado' });

  const absPath = path.resolve(doc.file_path);
  if (fs.existsSync(absPath)) fs.unlinkSync(absPath);

  fileRepo.update(req.params.fileId, { status: 'ELIMINADO_DISCO' });
  publishingStatusRepo.deleteByFileId(Number(req.params.fileId));
  deleteThumbnail(doc.id);

  res.json({ message: 'Archivo eliminado del disco' });
};

// ── GET /api/videos/:fileId/player-data ──────────────────────────────────────
export const getVideoPlayerData = async (req: Request, res: Response): Promise<void> => {
  const doc = fileRepo.findById(req.params.fileId);
  if (!doc) { res.status(404).json({ message: 'No encontrado.' }); return; }

  // Sin duracion_segundos todavía (el plugin de transcripción no la calculó):
  // la probamos con ffprobe acá mismo, en vez de dejar que el frontend estime
  // un valor falso ("0:15" fijo) a partir del texto de la transcripción.
  let durationSec = doc.duracion_segundos ?? 0;
  if (!durationSec && fs.existsSync(doc.file_path)) {
    durationSec = await probeDuration(doc.file_path);
    if (durationSec) fileRepo.update(doc.id, { duracion_segundos: durationSec });
  }

  const tr = transcriptRepo.findByFileId(doc.id);
  res.json({
    file: {
      _id: String(doc.id),
      file_name: doc.file_name,
      duration_seconds: durationSec,
      formato: doc.formato ?? 'HORIZONTAL',
      resolucion: doc.resolucion ?? '',
    },
    transcript: tr ? {
      _id: String(doc.id),
      transcript_text: tr.text,
      tipo_contenido: doc.tipo_contenido ?? null,
      palabras_por_minuto: 0,
      language: tr.language,
    } : null,
    script: null,
  });
};

// ── GET /api/metrics ──────────────────────────────────────────────────────────
export const getMetrics = (_req: Request, res: Response) => {
  const totalVideos = fileRepo.countAll();
  res.json({ totalVideos, guionesEstructurados: 0, clipsRandom: 0, clipsSinVoz: 0 });
};

// ── PATCH /api/videos/:fileId/scheduled-date ─────────────────────────────────
export const updateScheduledDate = (req: Request, res: Response): void => {
  const { scheduled_date } = req.body as { scheduled_date?: string | null };
  const updated = fileRepo.update(req.params.fileId, {
    scheduled_date: scheduled_date ?? null,
  });
  if (!updated) { res.status(404).json({ message: 'No encontrado.' }); return; }
  const doc = fileRepo.findById(req.params.fileId);
  res.json({ scheduled_date: doc?.scheduled_date ?? null });
};

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
