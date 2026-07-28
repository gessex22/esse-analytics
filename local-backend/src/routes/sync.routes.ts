import { Router } from 'express';
import { getCalendarConfig, updateCalendarConfig, getUploadHistory, getGroupStats, getFileStats } from '../controllers/sync.controller';
import { getPublishedVideosRefresh } from '../controllers/published-videos.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/sync/calendar-config',            verifyToken, getCalendarConfig);
router.get('/api/sync/published-videos',           verifyToken, getPublishedVideosRefresh);
router.get('/api/sync/history',                    verifyToken, getUploadHistory);
router.get('/api/sync/group-stats',                 verifyToken, getGroupStats);
router.get('/api/sync/file-stats',                  verifyToken, getFileStats);
router.patch('/api/sync/calendar-config/:platform', verifyToken, updateCalendarConfig);

export default router;
