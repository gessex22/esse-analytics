import { Router } from 'express';
import { getAllPublishingStatus, updatePublishingStatus } from '../controllers/publishingStatus.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/publishing-status',           getAllPublishingStatus);
router.patch('/api/publishing-status/:fileId', verifyToken, updatePublishingStatus);

export default router;
