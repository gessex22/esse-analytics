import { Router } from 'express';
import { getCalendarConfig, updateCalendarConfig } from '../controllers/sync.controller';
import { getPublishedVideosRefresh } from '../controllers/published-videos.controller';
import { pullRemoteUploads, getLastRemoteUpload, pullNextVideos } from '../controllers/sync-remote.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/sync/calendar-config',            verifyToken, getCalendarConfig);
router.get('/api/sync/published-videos',           verifyToken, getPublishedVideosRefresh);
router.patch('/api/sync/calendar-config/:platform', verifyToken, updateCalendarConfig);

// Sincronizar uploads remotos de la central
router.post('/api/sync/pull-remote-uploads',      verifyToken, pullRemoteUploads);
router.get('/api/sync/last-remote-upload/:platform', verifyToken, getLastRemoteUpload);

// Sincronizar próximos videos (bidireccional)
router.post('/api/sync/pull-next-videos',         verifyToken, pullNextVideos);

export default router;
