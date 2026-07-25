import { Router } from 'express';
import {
  getVideos, getVideoSlimList, getVideoSlimPendingTranscript, getVideoPlayerData,
  updateVideoContentStatus, updateVideoPlatforms, updateVideosBulk, resolvePublicationSelection,
  renameVideo, deleteFileFromDisk, getMetrics, updateScheduledDate, getVideoThumbnail,
  resolveFilesByName, getPlatformLinks, setPlatformLink,
} from '../controllers/video.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/videos',                              verifyToken, getVideos);
// Sin verifyToken: las consume esse_transcrip.py (proceso local, sin sesión de usuario),
// igual que /api/videos/:id/transcript y el resto de rutas plugin-facing.
router.get('/api/videos/slim',                         getVideoSlimList);
router.post('/api/videos/resolve-by-name',             verifyToken, resolveFilesByName);
router.get('/api/videos/slim/pending-transcript',      getVideoSlimPendingTranscript);
router.get('/api/metrics',                             verifyToken, getMetrics);
router.get('/api/videos/:fileId/player-data',          verifyToken, getVideoPlayerData);
// Sin verifyToken: <img src> no puede mandar headers custom, igual que /stream/:id.
router.get('/api/videos/:fileId/thumbnail',            getVideoThumbnail);
router.patch('/api/videos/:fileId/rename',             verifyToken, renameVideo);
router.patch('/api/videos/:fileId/status',             verifyToken, updateVideoContentStatus);
router.patch('/api/videos/:fileId/platforms',          verifyToken, updateVideoPlatforms);
router.post('/api/videos/:fileId/publication-selection', verifyToken, resolvePublicationSelection);
router.get('/api/videos/:fileId/platform-links',       verifyToken, getPlatformLinks);
router.patch('/api/videos/:fileId/platform-link/:platform', verifyToken, setPlatformLink);
router.patch('/api/videos/bulk',                       verifyToken, updateVideosBulk);
router.patch('/api/videos/:fileId/scheduled-date',     verifyToken, updateScheduledDate);
router.delete('/api/videos/:fileId/delete-file',       verifyToken, deleteFileFromDisk);

export default router;
