import { Router, Request, Response } from 'express';
import { fileRepo } from '../db/file.repo';
import { transcriptRepo } from '../db/transcript.repo';

const router = Router();

// GET /api/videos/:id/transcript
router.get('/api/videos/:id/transcript', (req: Request, res: Response) => {
  const doc = transcriptRepo.findByFileId(req.params.id);
  if (!doc) { res.status(404).json({ message: 'Sin transcript.' }); return; }
  res.json(doc);
});

// POST /api/videos/:id/transcript  — usado por el plugin Python
router.post('/api/videos/:id/transcript', (req: Request, res: Response) => {
  const { text, language } = req.body as { text?: string; language?: string };
  if (!text?.trim()) { res.status(400).json({ message: 'text es requerido.' }); return; }

  const file = fileRepo.findById(req.params.id);
  if (!file) { res.status(404).json({ message: 'Archivo no encontrado.' }); return; }

  const doc = transcriptRepo.upsert(file.id, text.trim(), language ?? 'es');
  res.json(doc);
});

export default router;
