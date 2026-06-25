import { Router } from 'express';
import {
  getVideos, getVideoSlimList, getVideoPlayerData,
  updateVideoContentStatus, updateVideoPlatforms,
  renameVideo, deleteFileFromDisk, getMetrics, updateScheduledDate,
} from '../controllers/video.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/videos',                              verifyToken, getVideos);
router.get('/api/videos/slim',                         verifyToken, getVideoSlimList);
router.get('/api/metrics',                             verifyToken, getMetrics);
router.get('/api/videos/:fileId/player-data',          verifyToken, getVideoPlayerData);
router.patch('/api/videos/:fileId/rename',             verifyToken, renameVideo);
router.patch('/api/videos/:fileId/status',             verifyToken, updateVideoContentStatus);
router.patch('/api/videos/:fileId/platforms',          verifyToken, updateVideoPlatforms);
router.patch('/api/videos/:fileId/scheduled-date',     verifyToken, updateScheduledDate);
router.delete('/api/videos/:fileId/delete-file',       verifyToken, deleteFileFromDisk);

export default router;
