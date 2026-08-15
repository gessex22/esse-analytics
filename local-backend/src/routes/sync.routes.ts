import { Router } from 'express';
import { getCalendarConfig, updateCalendarConfig, getUploadHistory, getGroupStats, getFileStats, recordUploadEvent } from '../controllers/sync.controller';
import { getPublishedVideosRefresh } from '../controllers/published-videos.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/sync/calendar-config',            verifyToken, getCalendarConfig);
router.get('/api/sync/published-videos',           verifyToken, getPublishedVideosRefresh);
router.get('/api/sync/history',                    verifyToken, getUploadHistory);
// POST del mismo path (alias record-publish) -- mismo criterio que la
// central (backup.routes.ts), un cliente (celular en modo PC local) reporta
// una publicación acá. Ver recordUploadEvent, bug real 2026-08-15.
router.post('/api/sync/history',                    verifyToken, recordUploadEvent);
router.post('/api/sync/record-publish',              verifyToken, recordUploadEvent);
router.get('/api/sync/group-stats',                 verifyToken, getGroupStats);
router.get('/api/sync/file-stats',                  verifyToken, getFileStats);
router.patch('/api/sync/calendar-config/:platform', verifyToken, updateCalendarConfig);

export default router;
