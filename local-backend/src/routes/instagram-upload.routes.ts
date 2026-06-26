import { Router } from 'express';
import { uploadToInstagram } from '../controllers/instagram-upload.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.post('/api/instagram/upload', verifyToken, uploadToInstagram);

export default router;
