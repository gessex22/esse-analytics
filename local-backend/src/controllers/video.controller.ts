import { Request, Response } from 'express';
import { FileModel, FileContentStatus } from '../models/file.model';
import { PublishingStatusModel } from '../models/publishing-status.model';
import fs from 'fs';
import path from 'path';

// ── GET /api/videos ───────────────────────────────────────────────────────────
export const getVideos = async (req: Request, res: Response) => {
  try {
    const page   = parseInt(req.query.page  as string) || 1;
    const limit  = parseInt(req.query.limit as string) || 10;
    const skip   = (page - 1) * limit;
    const { search, status, content_status } = req.query;

    const filters: any[] = [];
    if (search)         filters.push({ file_name: { $regex: search, $options: 'i' } });
    if (status)         filters.push({ status });
    if (content_status) filters.push({ content_status });
    else                filters.push({ $or: [{ content_status: { $exists: false } }, { content_status: { $ne: 'descartado' } }] });

    const matchStage = filters.length ? { $and: filters } : {};
    const sortOrder  = req.query.order === 'asc' ? 1 : -1;

    const results = await FileModel.aggregate([
      { $match: matchStage },
      { $addFields: { sort_date: { $ifNull: ['$fecha_creacion', '$createdAt'] } } },
      { $sort: { sort_date: sortOrder, _id: sortOrder } },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                file_id: {
                  _id: '$_id',
                  file_name: '$file_name',
                  file_path: '$file_path',
                  status: '$status',
                  content_status: '$content_status',
                  duracion_segundos: '$duracion_segundos',
                  resolucion: '$resolucion',
                  formato: '$formato',
                  fecha_creacion: { $ifNull: ['$fecha_creacion', '$createdAt'] },
                },
                platforms: 1,
                duracion_segundos: 1,
                resolucion: 1,
                formato: 1,
                fecha_creacion: { $ifNull: ['$fecha_creacion', '$createdAt'] },
              },
            },
          ],
        },
      },
    ]);

    const totalRecords = results[0]?.metadata[0]?.total || 0;
    const totalPages   = Math.ceil(totalRecords / limit);
    res.json({
      info: { totalRecords, totalPages, currentPage: page, nextPage: page < totalPages ? page + 1 : null, prevPage: page > 1 ? page - 1 : null },
      results: results[0]?.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
};

// ── GET /api/videos/slim ──────────────────────────────────────────────────────
export const getVideoSlimList = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 1200, 2000);
    const files = await FileModel.find({ status: { $ne: 'ELIMINADO_DISCO' } })
      .sort({ fecha_creacion: -1 }).limit(limit)
      .select('_id file_name duracion_segundos').lean();
    res.json(files.map(f => ({
      fileId:   String(f._id),
      title:    f.file_name,
      duration: f.duracion_segundos ? formatDuration(f.duracion_segundos as number) : '',
    })));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /api/videos/:fileId/status ─────────────────────────────────────────
export const updateVideoContentStatus = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const { status } = req.body as { status?: FileContentStatus };
  const valid: FileContentStatus[] = ['publicado', 'borrador', 'procesando', 'descartado'];
  if (!status || !valid.includes(status)) { res.status(400).json({ message: 'Estado inválido.' }); return; }
  try {
    const doc = await FileModel.findByIdAndUpdate(fileId, { content_status: status }, { returnDocument: 'after' });
    if (!doc) { res.status(404).json({ message: 'Archivo no encontrado.' }); return; }
    res.json({ content_status: doc.content_status });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /api/videos/:fileId/platforms ──────────────────────────────────────
export const updateVideoPlatforms = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const { platforms } = req.body as { platforms?: string[] };
  if (!Array.isArray(platforms) || platforms.some(p => !['youtube','instagram','tiktok'].includes(p))) {
    res.status(400).json({ message: 'Plataformas inválidas.' }); return;
  }
  try {
    const doc = await FileModel.findByIdAndUpdate(fileId, { platforms }, { returnDocument: 'after' });
    if (!doc) { res.status(404).json({ message: 'No encontrado.' }); return; }
    res.json({ platforms: doc.platforms });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /api/videos/:fileId/rename ─────────────────────────────────────────
export const renameVideo = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ message: 'Nombre vacío.' }); return; }
  const cleanName = name.trim();
  try {
    const doc = await FileModel.findById(fileId);
    if (!doc) { res.status(404).json({ message: 'No encontrado.' }); return; }
    const oldPath = path.resolve(doc.file_path);
    const newPath = path.join(path.dirname(oldPath), cleanName + path.extname(oldPath));
    let diskRenamed = false;
    if (fs.existsSync(oldPath)) { fs.renameSync(oldPath, newPath); diskRenamed = true; }
    await FileModel.findByIdAndUpdate(fileId, { file_name: cleanName, file_path: diskRenamed ? newPath : doc.file_path });
    res.json({ file_name: cleanName, file_path: diskRenamed ? newPath : doc.file_path, disk_renamed: diskRenamed });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/videos/:fileId/delete-file ────────────────────────────────────
export const deleteFileFromDisk = async (req: Request, res: Response) => {
  try {
    const doc = await FileModel.findById(req.params.fileId);
    if (!doc) return res.status(404).json({ error: 'No encontrado' });
    if (doc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'Ya eliminado' });
    const absPath = path.resolve(doc.file_path);
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    doc.status = 'ELIMINADO_DISCO';
    await doc.save();
    await PublishingStatusModel.deleteOne({ fileId: doc._id });
    res.json({ message: 'Archivo eliminado del disco' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar' });
  }
};

// ── GET /api/videos/:fileId/player-data ──────────────────────────────────────
export const getVideoPlayerData = async (req: Request, res: Response): Promise<void> => {
  try {
    const doc = await FileModel.findById(req.params.fileId).lean();
    if (!doc) { res.status(404).json({ message: 'No encontrado.' }); return; }
    res.json({
      file: { _id: doc._id, file_name: doc.file_name, duration_seconds: doc.duracion_segundos ?? 0, formato: doc.formato ?? 'HORIZONTAL', resolucion: doc.resolucion ?? '' },
      transcript: null,
      script: null,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/metrics ──────────────────────────────────────────────────────────
export const getMetrics = async (_req: Request, res: Response) => {
  try {
    const totalVideos = await FileModel.countDocuments();
    res.json({ totalVideos, guionesEstructurados: 0, clipsRandom: 0, clipsSinVoz: 0 });
  } catch {
    res.status(500).json({ error: 'Error al calcular métricas' });
  }
};

// ── PATCH /api/videos/:fileId/scheduled-date ─────────────────────────────────
export const updateScheduledDate = async (req: Request, res: Response): Promise<void> => {
  const { scheduled_date } = req.body as { scheduled_date?: string | null };
  try {
    const doc = await FileModel.findByIdAndUpdate(
      req.params.fileId,
      { scheduled_date: scheduled_date ? new Date(scheduled_date) : null },
      { returnDocument: 'after' },
    );
    if (!doc) { res.status(404).json({ message: 'No encontrado.' }); return; }
    res.json({ scheduled_date: doc.scheduled_date ?? null });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
