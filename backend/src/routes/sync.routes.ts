import { Router } from 'express';
import {
  triggerYouTubeSync, getYouTubeList, getSyncStats,
  getReviewList, confirmLink, markOrphan,
  getCalendarConfig, updateCalendarConfig,
} from '../controllers/sync.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.post('/api/sync/youtube',            verifyToken, requireRole('todopoderoso'), triggerYouTubeSync);
router.get ('/api/sync/youtube',            verifyToken, requireRole('todopoderoso'), getYouTubeList);
router.get ('/api/sync/stats',              verifyToken, requireRole('todopoderoso'), getSyncStats);
router.get ('/api/sync/review',                    verifyToken, requireRole('todopoderoso'), getReviewList);
router.post('/api/sync/review/:pvId/link',         verifyToken, requireRole('todopoderoso'), confirmLink);
router.post('/api/sync/review/:pvId/orphan',       verifyToken, requireRole('todopoderoso'), markOrphan);
router.get ('/api/sync/calendar-config',           verifyToken, getCalendarConfig);
router.patch('/api/sync/calendar-config/:platform',verifyToken, requireRole('todopoderoso'), updateCalendarConfig);

// router.post('/api/sync/instagram',   verifyToken, requireRole('todopoderoso'), triggerInstagramSync);
// router.post('/api/sync/tiktok',      verifyToken, requireRole('todopoderoso'), triggerTikTokSync);

export default router;
