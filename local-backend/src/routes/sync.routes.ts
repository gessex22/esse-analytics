import { Router } from 'express';
import { getCalendarConfig, updateCalendarConfig, getPublishedVideos } from '../controllers/sync.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/sync/calendar-config',            verifyToken, getCalendarConfig);
router.get('/api/sync/published-videos',           verifyToken, getPublishedVideos);
router.patch('/api/sync/calendar-config/:platform', verifyToken, updateCalendarConfig);

export default router;
