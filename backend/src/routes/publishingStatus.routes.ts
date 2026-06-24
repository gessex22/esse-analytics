import { Router } from 'express';
import { getAllPublishingStatus, updatePublishingStatus } from '../controllers/publishingStatus.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/publishing-status', getAllPublishingStatus);
router.patch('/api/publishing-status/:fileId', verifyToken, requireRole('todopoderoso'), updatePublishingStatus);

export default router;
