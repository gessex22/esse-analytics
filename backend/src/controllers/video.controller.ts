import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { TranscriptModel } from '../models/transcript.model';
import { FileModel, FileContentStatus } from '../models/file.model';
import { PublishingStatusModel } from '../models/publishing-status.model';
import { IdeaCentral } from '../models/ideacentral';
import fs from 'fs';
import path from 'path';

// ── GET /api/videos ───────────────────────────────────────────────────────────
export const getVideos = async (req: Request, res: Response) => {
  try {
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip  = (page - 1) * limit;

    const { search, tipo, status, content_status } = req.query;

    // Filtros a nivel de archivo (se aplican ANTES del JOIN con transcripts)
    const fileFilters: any[] = [];

    if (search) {
      fileFilters.push({ file_name: { $regex: search, $options: 'i' } });
    }
    if (status) {
      fileFilters.push({ status: status });
    }

    // Filtros derivados de los arrays de plataformas (fuente de verdad).
    // content_status como campo de DB ya no se usa para filtrar.
    const pArr  = { $ifNull: ['$platforms', []] };
    const pdArr = { $ifNull: ['$platforms_discarded', []] };
    if (content_status === 'sin_publicar') {
      fileFilters.push({ $expr: { $and: [{ $eq: [{ $size: pArr }, 0] }, { $eq: [{ $size: pdArr }, 0] }] } });
    } else if (content_status === 'parcial') {
      fileFilters.push({ $expr: { $and: [
        { $gt:  [{ $size: pArr }, 0] },
        { $lt:  [{ $add: [{ $size: pArr }, { $size: pdArr }] }, 3] },
      ]} });
    } else if (content_status === 'completo') {
      fileFilters.push({ $expr: { $gte: [{ $add: [{ $size: pArr }, { $size: pdArr }] }, 3] } });
    }

    const matchStage = fileFilters.length > 0 ? { $and: fileFilters } : {};

    // Filtro de tipo_contenido: vive en transcripts, se aplica DESPUÉS del JOIN
    const tipoMatchStage = tipo ? [{ $match: { 'transcript_data.tipo_contenido': tipo } }] : [];

    const sortOrder = req.query.order === 'asc' ? 1 : -1;

    const results = await FileModel.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from: 'transcripts',
          localField: '_id',
          foreignField: 'file_id',
          as: 'transcript_data',
        },
      },
      { $unwind: { path: '$transcript_data', preserveNullAndEmptyArrays: true } },
      ...tipoMatchStage,
      // Fecha unificada para ordenar: fecha real del archivo, con fallback a createdAt.
      // _id como segundo criterio garantiza orden estable cuando las fechas empatan.
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
                // El frontend espera 'file_id' como objeto anidado con los datos del archivo
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
                platforms_discarded: 1,
                duracion_segundos: 1,
                resolucion: 1,
                formato: 1,
                fecha_creacion: { $ifNull: ['$fecha_creacion', '$createdAt'] },
                // Datos de transcripción (si existen)
                transcript_text: '$transcript_data.transcript_text',
                tipo_contenido: '$transcript_data.tipo_contenido',
                palabras_por_minuto: '$transcript_data.palabras_por_minuto',
                processed_at: '$transcript_data.processed_at',
              },
            },
          ],
        },
      },
    ]);

    const totalRecords = results[0]?.metadata[0]?.total || 0;
    const transcripts  = results[0]?.data || [];
    const totalPages   = Math.ceil(totalRecords / limit);

    res.json({
      info: {
        totalRecords,
        totalPages,
        currentPage: page,
        nextPage: page < totalPages ? page + 1 : null,
        prevPage:  page > 1        ? page - 1 : null,
      },
      results: transcripts,
    });
  } catch (error) {
    console.error('Error al obtener videos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// ── PATCH /api/videos/:fileId/rename ─────────────────────────────────────────
// Renombra el archivo físico en disco, actualiza file_name y file_path en
// la colección 'files', y propaga file_name y file_path a
// ideas_centrales.videos_vinculados[].
export const renameVideo = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const { name }   = req.body as { name?: string };

  if (!name || name.trim().length === 0) {
    res.status(400).json({ message: 'El nombre no puede estar vacío.' });
    return;
  }

  const cleanName = name.trim();

  try {
    // 1. Buscar el documento actual para obtener file_path
    const fileDoc = await FileModel.findById(fileId);
    if (!fileDoc) {
      res.status(404).json({ message: 'Archivo no encontrado.' });
      return;
    }

    const oldPath = path.resolve(fileDoc.file_path);
    const ext     = path.extname(oldPath);          // e.g. ".mp4"
    const dir     = path.dirname(oldPath);
    const newPath = path.join(dir, cleanName + ext);

    // 2. Renombrar el archivo físico en disco (si existe)
    let diskRenamed = false;
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, newPath);
      diskRenamed = true;
      console.log(`-> Archivo renombrado en disco: ${oldPath} → ${newPath}`);
    } else {
      console.log(`-> Alerta: no se encontró el archivo en disco: ${oldPath}`);
    }

    const newFilePath = diskRenamed ? newPath : fileDoc.file_path;

    // 3. Actualizar en la colección 'files'
    await FileModel.findByIdAndUpdate(fileId, {
      file_name: cleanName,
      file_path: newFilePath,
    });

    // 4. Propagar a ideas_centrales.videos_vinculados (formato string)
    await IdeaCentral.updateMany(
      { 'videos_vinculados.file_id': fileId },
      {
        $set: {
          'videos_vinculados.$[v].file_name': cleanName,
          'videos_vinculados.$[v].file_path': newFilePath,
        },
      },
      { arrayFilters: [{ 'v.file_id': fileId }] }
    );

    // 5. Propagar también con formato ObjectId
    try {
      const fileObjectId = new mongoose.Types.ObjectId(fileId);
      await IdeaCentral.updateMany(
        { 'videos_vinculados.file_id': fileObjectId },
        {
          $set: {
            'videos_vinculados.$[v].file_name': cleanName,
            'videos_vinculados.$[v].file_path': newFilePath,
          },
        },
        { arrayFilters: [{ 'v.file_id': fileObjectId }] }
      );
    } catch {
      // fileId no era ObjectId válido — ignorar
    }

    res.status(200).json({
      message: diskRenamed
        ? 'Archivo renombrado en disco y base de datos.'
        : 'Nombre actualizado en base de datos (archivo físico no encontrado).',
      file_name: cleanName,
      file_path: newFilePath,
      disk_renamed: diskRenamed,
    });
  } catch (error: any) {
    console.error('Error al renombrar video:', error);
    res.status(500).json({ message: 'Error interno.', error: error.message });
  }
};

// ── PATCH /api/videos/:fileId/status ─────────────────────────────────────────
export const updateVideoContentStatus = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const { status } = req.body as { status?: FileContentStatus };

  const validStatuses: FileContentStatus[] = ['publicado', 'borrador', 'procesando', 'descartado'];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ message: 'Estado inválido.' });
    return;
  }

  try {
    const fileDoc = await FileModel.findByIdAndUpdate(
      fileId,
      { content_status: status },
      { returnDocument: 'after' }
    );

    if (!fileDoc) {
      res.status(404).json({ message: 'Archivo no encontrado.' });
      return;
    }

    res.status(200).json({ message: 'Estado actualizado.', content_status: fileDoc.content_status });
  } catch (error: any) {
    console.error('Error al actualizar estado:', error);
    res.status(500).json({ message: 'Error interno.', error: error.message });
  }
};

// ── GET /api/videos/:fileId/player-data ──────────────────────────────────────
// Devuelve file info + transcripción + guión para el reproductor modal
export const getVideoPlayerData = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;

  try {
    const fileDoc = await FileModel.findById(fileId).lean();
    if (!fileDoc) {
      res.status(404).json({ message: 'Archivo no encontrado.' });
      return;
    }

    // Transcripción por file_id
    const transcript = await TranscriptModel.findOne({ file_id: fileId }).lean();

    // Buscar idea asociada para obtener el guión
    let idea: any = null;
    try {
      const fileObjectId = new mongoose.Types.ObjectId(fileId);
      idea = await mongoose.connection.db!.collection('ideas_centrales').findOne({
        'videos_vinculados.file_id': { $in: [fileId, fileObjectId] },
      });
    } catch { /* fileId no era ObjectId válido */ }

    res.status(200).json({
      file: {
        _id:              fileDoc._id,
        file_name:        fileDoc.file_name,
        duration_seconds: fileDoc.duracion_segundos ?? 0,
        formato:          fileDoc.formato ?? 'HORIZONTAL',
        resolucion:       fileDoc.resolucion ?? '',
      },
      transcript: transcript
        ? {
            _id:             transcript._id,
            transcript_text: transcript.transcript_text,
            tipo_contenido:  transcript.tipo_contenido,
            palabras_por_minuto: transcript.palabras_por_minuto,
            language:        transcript.language,
          }
        : null,
      script: idea
        ? {
            idea_nucleo:    idea.idea_nucleo   ?? '',
            resumen_visual: idea.resumen_visual ?? '',
          }
        : null,
    });
  } catch (error: any) {
    console.error('Error al obtener datos del reproductor:', error);
    res.status(500).json({ message: 'Error interno.', error: error.message });
  }
};

// ── GET /api/metrics ──────────────────────────────────────────────────────────
export const getMetrics = async (req: Request, res: Response) => {
  try {
    const totalVideos            = await FileModel.countDocuments();
    const guionesEstructurados   = await TranscriptModel.countDocuments({ tipo_contenido: 'GUION_ESTRUCTURADO' });
    const clipsRandom            = await TranscriptModel.countDocuments({ tipo_contenido: 'CLIP_RANDOM' });
    const clipsSinVoz            = await TranscriptModel.countDocuments({ tipo_contenido: 'CLIP_SIN_VOZ' });

    res.json({ totalVideos, guionesEstructurados, clipsRandom, clipsSinVoz });
  } catch (error) {
    console.error('Error al obtener métricas:', error);
    res.status(500).json({ error: 'Error al calcular métricas' });
  }
};

// ── DELETE /api/videos/:fileId/delete-file ────────────────────────────────────
export const deleteFileFromDisk = async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const fileDoc = await FileModel.findById(fileId);

    if (!fileDoc) return res.status(404).json({ error: 'Archivo no encontrado' });
    if (fileDoc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo ya fue eliminado' });

    const absolutePath = path.resolve(fileDoc.file_path);
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);

    fileDoc.status = 'ELIMINADO_DISCO';
    await fileDoc.save();

    await Promise.allSettled([
      TranscriptModel.deleteOne({ file_id: new mongoose.Types.ObjectId(fileId) }),
      PublishingStatusModel.deleteOne({ fileId: new mongoose.Types.ObjectId(fileId) }),
    ]);

    res.json({ message: 'Archivo eliminado físicamente del disco' });
  } catch (error) {
    console.error('Error al eliminar archivo:', error);
    res.status(500).json({ error: 'Error al eliminar el archivo físico' });
  }
};

// ── GET /api/calendar ─────────────────────────────────────────────────────────
// Devuelve todos los videos del mes indicado con su estado de publicación por plataforma.
// Query params: ?year=2025&month=6 (month es 1-indexado)
export const getCalendarVideos = async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year  as string) || now.getFullYear();
    const month = parseInt(req.query.month as string) || (now.getMonth() + 1);

    const startDate = new Date(year, month - 1, 1);
    const endDate   = new Date(year, month, 1);

    const results = await TranscriptModel.aggregate([
      {
        $lookup: {
          from: 'files',
          localField: 'file_id',
          foreignField: '_id',
          as: 'file_info',
        },
      },
      { $unwind: '$file_info' },
      {
        $addFields: {
          effective_date: {
            $ifNull: [
              '$file_info.scheduled_date',
              { $ifNull: ['$file_info.fecha_creacion', '$file_info.createdAt'] },
            ],
          },
        },
      },
      {
        $match: {
          effective_date: { $gte: startDate, $lt: endDate },
          $or: [
            { 'file_info.content_status': { $exists: false } },
            { 'file_info.content_status': { $ne: 'descartado' } },
          ],
        },
      },
      {
        $lookup: {
          from: 'platformvideos',
          localField: 'file_info._id',
          foreignField: 'linkedFileId',
          as: 'platform_videos',
        },
      },
      {
        $project: {
          _id: 1,
          fileId: '$file_info._id',
          title: '$file_info.file_name',
          date: '$effective_date',
          content_status: { $ifNull: ['$file_info.content_status', 'borrador'] },
          target_platforms: { $ifNull: ['$file_info.platforms', []] },
          published_platforms: '$platform_videos.platform',
          tipo_contenido: 1,
          duracion_segundos: '$file_info.duracion_segundos',
          scheduled_date: '$file_info.scheduled_date',
        },
      },
      { $sort: { date: 1 } },
    ]);

    res.json({ videos: results });
  } catch (error) {
    console.error('Error al obtener videos del calendario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// ── PATCH /api/videos/:fileId/scheduled-date ─────────────────────────────────
export const updateScheduledDate = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const { scheduled_date } = req.body as { scheduled_date?: string | null };

  try {
    const fileDoc = await FileModel.findByIdAndUpdate(
      fileId,
      { scheduled_date: scheduled_date ? new Date(scheduled_date) : null },
      { returnDocument: 'after' }
    );
    if (!fileDoc) {
      res.status(404).json({ message: 'Archivo no encontrado.' });
      return;
    }
    res.json({ scheduled_date: fileDoc.scheduled_date ?? null });
  } catch (error: any) {
    console.error('Error al actualizar fecha programada:', error);
    res.status(500).json({ message: 'Error interno.', error: error.message });
  }
};

// ── PATCH /api/videos/:fileId/platforms ──────────────────────────────────────
export const updateVideoPlatforms = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const { platforms, platforms_discarded } = req.body as { platforms?: string[]; platforms_discarded?: string[] };

  const valid = ['youtube', 'instagram', 'tiktok'];
  if (!Array.isArray(platforms) || platforms.some(p => !valid.includes(p))) {
    res.status(400).json({ message: 'Plataformas inválidas.' });
    return;
  }
  if (platforms_discarded !== undefined && (!Array.isArray(platforms_discarded) || platforms_discarded.some(p => !valid.includes(p)))) {
    res.status(400).json({ message: 'platforms_discarded inválido.' });
    return;
  }

  const update: any = { platforms };
  if (platforms_discarded !== undefined) update.platforms_discarded = platforms_discarded;

  try {
    const fileDoc = await FileModel.findByIdAndUpdate(
      fileId,
      update,
      { returnDocument: 'after' }
    );
    if (!fileDoc) {
      res.status(404).json({ message: 'Archivo no encontrado.' });
      return;
    }
    res.json({ platforms: fileDoc.platforms });
  } catch (error: any) {
    res.status(500).json({ message: 'Error interno.', error: error.message });
  }
}

// ── GET /api/videos/slim — lista ligera para el selector de cola ──────────────
// Solo devuelve los campos mínimos necesarios; sin joins ni transcripciones.
export const getVideoSlimList = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 1200, 2000);

    const files = await FileModel.find({ status: { $ne: 'ELIMINADO_DISCO' } })
      .sort({ fecha_creacion: -1 })
      .limit(limit)
      .select('_id file_name duracion_segundos fecha_creacion')
      .lean();

    res.json(files.map(f => ({
      fileId:    String(f._id),
      title:     f.file_name,
      duration:  f.duracion_segundos ? formatDuration(f.duracion_segundos as number) : '',
    })));
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
