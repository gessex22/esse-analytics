import { Router } from 'express';
import { uploadToTikTok } from '../controllers/tiktok-upload.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.post('/api/tiktok/upload', verifyToken, uploadToTikTok);

export default router;
