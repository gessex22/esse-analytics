import { Response } from 'express';
import { getDb, persist } from '../store/db';
import { AuthRequest } from '../middleware/auth.middleware';

// Mismo shape que local-backend/src/controllers/publishingStatus.controller.ts.
// A diferencia de local (SQLite por PC), acá vive en el store compartido del
// Laboratorio -- así el estado "publicado en X" es visible desde cualquier
// dispositivo logueado con la misma cuenta.
export const getAllPublishingStatus = (req: AuthRequest, res: Response): void => {
  const userId = req.user?.id;
  const docs = getDb().publishingStatus.filter(d => !userId || d.userId === userId);
  res.json(docs.map(d => ({
    _id: d.id, fileId: d.fileId, title: d.title,
    tiktok_published: d.tiktok_published, instagram_published: d.instagram_published, youtube_published: d.youtube_published,
    createdAt: d.createdAt,
  })));
};

export const updatePublishingStatus = (req: AuthRequest, res: Response): void => {
  const { fileId } = req.params as { fileId: string };
  const { tiktok_published, instagram_published, youtube_published } = req.body ?? {};
  const db = getDb();
  const userId = req.user!.id;
  const file = db.files.find(f => f.id === fileId && f.userId === userId);
  if (!file) { res.status(404).json({ error: 'Archivo no encontrado' }); return; }

  let doc = db.publishingStatus.find(d => d.fileId === fileId && d.userId === userId);
  if (!doc) {
    doc = { id: `${Date.now()}`, userId, fileId, title: file.fileName, tiktok_published: false, instagram_published: false, youtube_published: false, createdAt: new Date().toISOString() };
    db.publishingStatus.push(doc);
  }
  if (typeof tiktok_published === 'boolean') doc.tiktok_published = tiktok_published;
  if (typeof instagram_published === 'boolean') doc.instagram_published = instagram_published;
  if (typeof youtube_published === 'boolean') doc.youtube_published = youtube_published;
  persist();
  res.json({ _id: doc.id, fileId: doc.fileId, title: doc.title, tiktok_published: doc.tiktok_published, instagram_published: doc.instagram_published, youtube_published: doc.youtube_published, createdAt: doc.createdAt });
};
