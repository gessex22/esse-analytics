import { Request, Response } from 'express';
import { publishingStatusRepo } from '../db/publishing-status.repo';
import { fileRepo } from '../db/file.repo';

export async function getAllPublishingStatus(_req: Request, res: Response): Promise<void> {
  try {
    const docs = publishingStatusRepo.findAll();
    res.json(docs.map(d => ({
      _id: String(d.id),
      fileId: String(d.file_id),
      title: d.title,
      tiktok_published: d.tiktok_published,
      instagram_published: d.instagram_published,
      youtube_published: d.youtube_published,
      createdAt: d.created_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updatePublishingStatus(req: Request, res: Response): Promise<void> {
  try {
    const { fileId } = req.params;
    const { tiktok_published, instagram_published, youtube_published } = req.body;

    const updates: Record<string, boolean> = {};
    if (typeof tiktok_published    === 'boolean') updates.tiktok_published    = tiktok_published;
    if (typeof instagram_published === 'boolean') updates.instagram_published = instagram_published;
    if (typeof youtube_published   === 'boolean') updates.youtube_published   = youtube_published;

    if (!Object.keys(updates).length) { res.status(400).json({ error: 'Sin campos a actualizar' }); return; }

    const file = fileRepo.findById(fileId);
    if (!file) { res.status(404).json({ error: 'Archivo no encontrado' }); return; }

    const doc = publishingStatusRepo.upsert(Number(fileId), file.file_name, updates);
    res.json({
      _id: String(doc.id),
      fileId: String(doc.file_id),
      title: doc.title,
      tiktok_published: doc.tiktok_published,
      instagram_published: doc.instagram_published,
      youtube_published: doc.youtube_published,
      createdAt: doc.created_at,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
