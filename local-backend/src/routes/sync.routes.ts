import { Router } from 'express';
import { getCalendarConfig, updateCalendarConfig } from '../controllers/sync.controller';
import { getPublishedVideosRefresh } from '../controllers/published-videos.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/sync/calendar-config',            verifyToken, getCalendarConfig);
router.get('/api/sync/published-videos',           verifyToken, getPublishedVideosRefresh);
router.patch('/api/sync/calendar-config/:platform', verifyToken, updateCalendarConfig);

export default router;
