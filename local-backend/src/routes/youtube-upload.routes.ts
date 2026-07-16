import { Router } from 'express';
import { uploadToYoutube, setThumbnail } from '../controllers/youtube-upload.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

// Upload desde biblioteca local (el archivo está en disco local)
router.post('/api/youtube/upload', verifyToken, uploadToYoutube);
// Miniatura personalizada — no existía localmente, por eso siempre fallaba en
// la app de escritorio (el frontend le pega al local-backend, no a la central).
router.post('/api/youtube/thumbnail/:videoId', verifyToken, setThumbnail);

export default router;
