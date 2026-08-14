import { Router } from 'express';
import { getAllPublishingStatus, updatePublishingStatus } from '../controllers/publishingStatus.controller';
import { verifyToken } from '../middleware/auth.middleware';

// LEGACY (2026-08-13): sin consumidores en el frontend, ver
// db/publishing-status.repo.ts. No agregar nuevos usos.
const router = Router();

router.get('/api/publishing-status',           getAllPublishingStatus);
router.patch('/api/publishing-status/:fileId', verifyToken, updatePublishingStatus);

export default router;
