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

// POST /api/videos/:id/transcript  — usado por el plugin Python (esse_transcrip)
router.post('/api/videos/:id/transcript', (req: Request, res: Response) => {
  const { text, language, tipo_contenido } = req.body as { text?: string; language?: string; tipo_contenido?: string };
  if (!text?.trim()) { res.status(400).json({ message: 'text es requerido.' }); return; }

  const file = fileRepo.findById(req.params.id);
  if (!file) { res.status(404).json({ message: 'Archivo no encontrado.' }); return; }

  const doc = transcriptRepo.upsert(file.id, text.trim(), language ?? 'es');
  if (tipo_contenido) fileRepo.update(file.id, { tipo_contenido });
  res.json(doc);
});

export default router;
