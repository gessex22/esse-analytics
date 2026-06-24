import { Router } from 'express';
import {
  getAuthUrl,
  handleCallback,
  getAuthStatus,
  revokeAuth,
  getChannelInfo,
  uploadToYoutube,
  setThumbnail,
} from '../controllers/youtube-upload.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

// OAuth — públicas (el callback viene de Google)
router.get('/api/youtube/auth/url',      verifyToken, requireRole('todopoderoso'), getAuthUrl);
router.get('/api/youtube/auth/callback', handleCallback);
router.get('/api/youtube/auth/status',   verifyToken, getAuthStatus);
router.delete('/api/youtube/auth',       verifyToken, requireRole('todopoderoso'), revokeAuth);
router.get('/api/youtube/channel-info',  verifyToken, requireRole('todopoderoso'), getChannelInfo);

// Upload
router.post('/api/youtube/upload',                  verifyToken, requireRole('todopoderoso'), uploadToYoutube);
router.post('/api/youtube/thumbnail/:videoId',       verifyToken, requireRole('todopoderoso'), setThumbnail);

export default router;
