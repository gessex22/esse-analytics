import { Router } from 'express';
import { getTranscripStatus } from '../controllers/components.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/components/transcrip', verifyToken, getTranscripStatus);

export default router;
