import { Router } from 'express';
import { getCalendarConfig, updateCalendarConfig } from '../controllers/sync.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/sync/calendar-config',            verifyToken, getCalendarConfig);
router.patch('/api/sync/calendar-config/:platform', verifyToken, updateCalendarConfig);

export default router;
