import { Request, Response } from 'express';
import { PublishingStatusModel } from '../models/publishing-status.model';
import { FileModel } from '../models/file.model';

export async function getAllPublishingStatus(req: Request, res: Response): Promise<void> {
  try {
    // Sort by fecha_creacion (real file creation date) from the files collection
    const docs = await PublishingStatusModel.aggregate([
      {
        $lookup: {
          from:         'files',
          localField:   'fileId',
          foreignField: '_id',
          as:           '_file',
          pipeline:     [{ $project: { fecha_creacion: 1 } }],
        },
      },
      {
        $addFields: {
          _fecha_creacion: { $arrayElemAt: ['$_file.fecha_creacion', 0] },
        },
      },
      { $sort: { _fecha_creacion: -1 } },
      { $project: { _file: 0, _fecha_creacion: 0 } },
    ]);
    res.json(docs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updatePublishingStatus(req: Request, res: Response): Promise<void> {
  try {
    const { fileId } = req.params;
    const { tiktok_published, instagram_published, youtube_published } = req.body;

    const update: Record<string, boolean> = {};
    if (typeof tiktok_published    === 'boolean') update.tiktok_published    = tiktok_published;
    if (typeof instagram_published === 'boolean') update.instagram_published = instagram_published;
    if (typeof youtube_published   === 'boolean') update.youtube_published   = youtube_published;

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    // Si no existe registro para este archivo, lo creamos (upsert).
    // Necesitamos el título del archivo para el caso de creación.
    const file = await FileModel.findById(fileId, { file_name: 1 }).lean();
    if (!file) {
      res.status(404).json({ error: 'File not found for this fileId' });
      return;
    }

    const doc = await PublishingStatusModel.findOneAndUpdate(
      { fileId },
      {
        $set: update,
        $setOnInsert: { title: file.file_name, createdAt: new Date() },
      },
      { returnDocument: 'after', upsert: true },
    );

    res.json(doc);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
