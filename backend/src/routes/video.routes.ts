import { Router } from 'express';
import {
  getVideos,
  getMetrics,
  deleteFileFromDisk,
  renameVideo,
  updateVideoContentStatus,
  updateVideoPlatforms,
  updateScheduledDate,
  getVideoPlayerData,
  getCalendarVideos,
  getVideoSlimList,
} from '../controllers/video.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

// Rutas públicas (lectura)
router.get('/api/videos/slim',                    getVideoSlimList);
router.get('/api/videos',                         getVideos);
router.get('/api/metrics',                        getMetrics);
router.get('/api/calendar',                       getCalendarVideos);
router.get('/api/videos/:fileId/player-data',     getVideoPlayerData);

// Rutas protegidas — solo todopoderoso
router.patch('/api/videos/:fileId/rename',          verifyToken, requireRole('todopoderoso'), renameVideo);
router.patch('/api/videos/:fileId/status',          verifyToken, requireRole('todopoderoso'), updateVideoContentStatus);
router.patch('/api/videos/:fileId/platforms',       verifyToken, requireRole('todopoderoso'), updateVideoPlatforms);
router.patch('/api/videos/:fileId/scheduled-date',  verifyToken, requireRole('todopoderoso'), updateScheduledDate);
router.delete('/api/videos/:fileId/delete-file',    verifyToken, requireRole('todopoderoso'), deleteFileFromDisk);

export default router;
