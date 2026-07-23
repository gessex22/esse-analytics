import { Router } from 'express';
import {
  triggerYouTubeSync, getYouTubeList, getSyncStats,
  getReviewList, confirmLink, markOrphan,
  getPlatformRecent, confirmCrossMatch,
  getCrossMatchCandidates, resolveCrossMatchSlot, getGroupStats, getStatsByIds,
  getCalendarConfig, updateCalendarConfig,
} from '../controllers/sync.controller';
import { getPublishedCards, mirrorPublishedCards } from '../controllers/published-cards.controller';
import { getUploadHistory, recordUploadEvent } from '../controllers/backup.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

// Tarjetas de "último publicado" — la app las espeja (POST) y la web/remoto las lee (GET).
router.get ('/api/sync/published-videos', verifyToken, getPublishedCards);
router.post('/api/sync/published-videos', verifyToken, mirrorPublishedCards);

router.post('/api/sync/youtube',            verifyToken, requireRole('todopoderoso'), triggerYouTubeSync);
router.get ('/api/sync/youtube',            verifyToken, requireRole('todopoderoso'), getYouTubeList);
router.get ('/api/sync/stats',              verifyToken, requireRole('todopoderoso'), getSyncStats);
router.get ('/api/sync/review',                    verifyToken, requireRole('todopoderoso'), getReviewList);
router.post('/api/sync/review/:pvId/link',         verifyToken, requireRole('todopoderoso'), confirmLink);
router.post('/api/sync/review/:pvId/orphan',       verifyToken, requireRole('todopoderoso'), markOrphan);
router.get ('/api/sync/platform-recent/:platform', verifyToken, requireRole('todopoderoso'), getPlatformRecent);
router.post('/api/sync/cross-match',               verifyToken, requireRole('todopoderoso'), confirmCrossMatch);
router.get ('/api/sync/cross-match/candidates',     verifyToken, requireRole('todopoderoso'), getCrossMatchCandidates);
router.post('/api/sync/cross-match/resolve',        verifyToken, requireRole('todopoderoso'), resolveCrossMatchSlot);
// Estadísticas: liberado a cualquier usuario logueado (antes solo el dueño) --
// ya viene scoped por userId en el controller, el requireRole era una
// restricción extra sin motivo real de seguridad.
router.get ('/api/sync/group-stats',                verifyToken, getGroupStats);
router.post('/api/sync/stats-by-ids',               verifyToken, getStatsByIds);
router.get ('/api/sync/history',                    verifyToken, getUploadHistory);
router.post('/api/sync/history',                    verifyToken, recordUploadEvent);
// Alias: iOS (SyncAPI.recordPublish, ya escrito y con backfill retroactivo en
// Settings) llama a este nombre -- mismo handler, evita tener que tocar/re-buildear
// la app de iOS (no hay forma de compilarla/probarla desde esta máquina Windows).
router.post('/api/sync/record-publish',             verifyToken, recordUploadEvent);
router.get ('/api/sync/calendar-config',           verifyToken, getCalendarConfig);
router.patch('/api/sync/calendar-config/:platform',verifyToken, requireRole('todopoderoso'), updateCalendarConfig);

// router.post('/api/sync/instagram',   verifyToken, requireRole('todopoderoso'), triggerInstagramSync);
// router.post('/api/sync/tiktok',      verifyToken, requireRole('todopoderoso'), triggerTikTokSync);

export default router;
