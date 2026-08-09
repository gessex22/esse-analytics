import { Router } from 'express';
import {
  getCalendarConfig, updateCalendarConfig, skipNextCalendarVideo,
  getGroupStats, getFileStats, getUploadHistory, recordUploadEvent,
  getPublishedCards, mirrorPublishedCards,
} from '../controllers/sync.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/sync/published-videos', verifyToken, getPublishedCards);
router.post('/api/sync/published-videos', verifyToken, mirrorPublishedCards);

router.get('/api/sync/group-stats', verifyToken, getGroupStats);
router.get('/api/sync/file-stats', verifyToken, getFileStats);
router.get('/api/sync/history', verifyToken, getUploadHistory);
router.post('/api/sync/history', verifyToken, recordUploadEvent);
// Alias -- iOS llama a este nombre (ver backend/src/routes/sync.routes.ts).
router.post('/api/sync/record-publish', verifyToken, recordUploadEvent);

router.get('/api/sync/calendar-config', verifyToken, getCalendarConfig);
router.patch('/api/sync/calendar-config/:platform', verifyToken, updateCalendarConfig);
router.post('/api/sync/calendar-config/:platform/skip-next', verifyToken, skipNextCalendarVideo);

export default router;
