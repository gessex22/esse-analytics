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
  const { text, language, tipo_contenido, duration_seconds } = req.body as {
    text?: string; language?: string; tipo_contenido?: string; duration_seconds?: number;
  };
  if (!text?.trim()) { res.status(400).json({ message: 'text es requerido.' }); return; }

  const file = fileRepo.findById(req.params.id);
  if (!file) { res.status(404).json({ message: 'Archivo no encontrado.' }); return; }

  const doc = transcriptRepo.upsert(file.id, text.trim(), language ?? 'es');
  // TRANSCRITO es lo que usan idea.repo.ts y el resto de la app para saber que este
  // archivo ya tiene transcripción real — antes nunca se seteaba. duration_seconds:
  // el watcher nunca la mide (no corre ffprobe), pero faster-whisper sí la calcula
  // como parte de transcribir, así que la aprovechamos para completar el dato.
  fileRepo.update(file.id, {
    status: 'TRANSCRITO',
    ...(tipo_contenido ? { tipo_contenido } : {}),
    ...(duration_seconds ? { duracion_segundos: duration_seconds } : {}),
  });
  res.json(doc);
});

export default router;
