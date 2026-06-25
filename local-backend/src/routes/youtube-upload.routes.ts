import { Router } from 'express';
import { uploadToYoutube } from '../controllers/youtube-upload.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

// Upload desde biblioteca local (el archivo está en disco local)
router.post('/api/youtube/upload', verifyToken, uploadToYoutube);

export default router;
