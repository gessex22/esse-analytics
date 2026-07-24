import { Router } from 'express';
import { getAllUploadProgress } from '../state/upload-activity';
import { getPreloadActivity } from '../state/remote-library-preload-activity';

const router = Router();

// GET /api/upload-status — jobs de subida en curso (YouTube/Instagram/TikTok), poll liviano.
router.get('/api/upload-status', (_req, res) => {
  res.json(getAllUploadProgress());
});

// GET /api/remote-library-preload-status — precarga automática a Biblioteca
// remota del "próximo a publicar" (ver remote-library-preload.service.ts).
// Endpoint aparte de /api/upload-status: es una actividad distinta (guardar en
// la nube para más adelante, no publicar ahora) y mezclarla en el mismo array
// tipado a youtube/instagram/tiktok hubiera confundido esa etiqueta.
router.get('/api/remote-library-preload-status', (_req, res) => {
  res.json(getPreloadActivity());
});

export default router;
