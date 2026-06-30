import { Router } from 'express';
import {
  triggerYouTubeSync, getYouTubeList, getSyncStats,
  getReviewList, confirmLink, markOrphan,
  getCalendarConfig, updateCalendarConfig, getRemoteUploads,
  getNextVideos, updateNextVideo,
} from '../controllers/sync.controller';
import { getPublishedCards, mirrorPublishedCards } from '../controllers/published-cards.controller';
import { getPublishedStats, refreshAllStats } from '../controllers/published-stats.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

// Tarjetas de "último publicado" — la app las espeja (POST) y la web/remoto las lee (GET).
router.get ('/api/sync/published-videos', verifyToken, getPublishedCards);
router.post('/api/sync/published-videos', verifyToken, mirrorPublishedCards);

// Stats de plataformas reales (views, likes, comments, etc.)
router.get ('/api/sync/published-stats/:platform/:platformId', verifyToken, getPublishedStats);
router.post('/api/sync/refresh-all-stats', verifyToken, refreshAllStats);

// Remote uploads (para sincronización local-backend)
router.get ('/api/sync/remote-uploads', verifyToken, getRemoteUploads);

router.post('/api/sync/youtube',            verifyToken, requireRole('todopoderoso'), triggerYouTubeSync);
router.get ('/api/sync/youtube',            verifyToken, requireRole('todopoderoso'), getYouTubeList);
router.get ('/api/sync/stats',              verifyToken, requireRole('todopoderoso'), getSyncStats);
router.get ('/api/sync/review',                    verifyToken, requireRole('todopoderoso'), getReviewList);
router.post('/api/sync/review/:pvId/link',         verifyToken, requireRole('todopoderoso'), confirmLink);
router.post('/api/sync/review/:pvId/orphan',       verifyToken, requireRole('todopoderoso'), markOrphan);
router.get ('/api/sync/calendar-config',           verifyToken, getCalendarConfig);
router.patch('/api/sync/calendar-config/:platform',verifyToken, requireRole('todopoderoso'), updateCalendarConfig);

// Próximos videos (sincronización bidireccional)
router.get ('/api/sync/next-videos',               verifyToken, getNextVideos);
router.patch('/api/sync/next-video/:platform',     verifyToken, updateNextVideo);

// router.post('/api/sync/instagram',   verifyToken, requireRole('todopoderoso'), triggerInstagramSync);
// router.post('/api/sync/tiktok',      verifyToken, requireRole('todopoderoso'), triggerTikTokSync);

export default router;
