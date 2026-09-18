import { Router } from 'express';
import {
  triggerYouTubeSync, getYouTubeList, getSyncStats,
  getReviewList, confirmLink, markOrphan,
  manualPlatformLinkEndpoint,
  getPlatformRecent, confirmCrossMatch,
  getCrossMatchCandidates, resolveCrossMatchSlot, getGroupStats, getFileStats, getStatsByIds, unlinkPlatform,
  applyPlatformTransitionEndpoint,
  resolveIdentityEndpoint,
  getCalendarConfig, updateCalendarConfig, skipNextCalendarVideo,
} from '../controllers/sync.controller';
import { getPublishedCards, mirrorPublishedCards } from '../controllers/published-cards.controller';
import { getUploadHistory, recordUploadEvent, updateFilePlatforms } from '../controllers/backup.controller';
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
// Vínculo explícito desde mobile: usa contentId porque el cliente no conoce
// el ObjectId interno de FileModel. Comparte la operación durable de los dos
// callers manuales del panel.
router.post('/api/sync/manual-platform-link',       verifyToken, manualPlatformLinkEndpoint);
// Estadísticas: liberado a cualquier usuario logueado (antes solo el dueño) --
// ya viene scoped por userId en el controller, el requireRole era una
// restricción extra sin motivo real de seguridad.
router.get ('/api/sync/group-stats',                verifyToken, getGroupStats);
router.get ('/api/sync/file-stats',                 verifyToken, getFileStats);
router.post('/api/sync/stats-by-ids',               verifyToken, getStatsByIds);
router.get ('/api/sync/history',                    verifyToken, getUploadHistory);
router.post('/api/sync/history',                    verifyToken, recordUploadEvent);
// Alias: iOS (SyncAPI.recordPublish, ya escrito y con backfill retroactivo en
// Settings) llama a este nombre -- mismo handler, evita tener que tocar/re-buildear
// la app de iOS (no hay forma de compilarla/probarla desde esta máquina Windows).
router.post('/api/sync/record-publish',             verifyToken, recordUploadEvent);
// :contentId (UUID), no el id local -- ver el comentario de unlinkPlatform.
router.delete('/api/sync/platform-link/:contentId/:platform', verifyToken, unlinkPlatform);
// Contrato explícito de transición: permite declarar operationId (dedup real y
// reanudación) y baseVersion (precedencia causal), cosas que el DELETE de arriba
// no puede expresar. Ver applyPlatformTransitionEndpoint.
router.post('/api/sync/platform-transition', verifyToken, applyPlatformTransitionEndpoint);
// Bootstrap de identidad: lo que un cliente sin `content_id` necesita ANTES de
// poder declarar una transición. Aparte de `file-platforms` a propósito -- ver
// el comentario de resolveIdentityEndpoint.
router.post('/api/sync/resolve-identity', verifyToken, resolveIdentityEndpoint);
// (Acá vivió GET /api/sync/platform-revisions, retirado a propósito: pedir la
// revisión aparte del estado abre una ventana en la que el cliente se queda con
// el estado de antes y la revisión de después, y esa combinación hace que la
// central ACEPTE una decisión tomada sobre otra cosa. La revisión viaja ahora
// dentro de GET /api/backup/files, junto al estado que describe.)
// "Descartar" desde iOS/Android era 100% local -- ver comentario completo en
// updateFilePlatforms (backup.controller.ts).
router.post('/api/sync/file-platforms',             verifyToken, updateFilePlatforms);
router.get ('/api/sync/calendar-config',           verifyToken, getCalendarConfig);
router.patch('/api/sync/calendar-config/:platform',verifyToken, requireRole('todopoderoso'), updateCalendarConfig);
router.post('/api/sync/calendar-config/:platform/skip-next', verifyToken, skipNextCalendarVideo);

// router.post('/api/sync/instagram',   verifyToken, requireRole('todopoderoso'), triggerInstagramSync);
// router.post('/api/sync/tiktok',      verifyToken, requireRole('todopoderoso'), triggerTikTokSync);

export default router;
