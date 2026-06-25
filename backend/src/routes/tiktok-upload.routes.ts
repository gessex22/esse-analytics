import { Router } from 'express';
import {
  getAuthUrl,
  handleCallback,
  getAuthStatus,
  revokeAuth,
  getCreatorInfo,
  uploadToTikTok,
} from '../controllers/tiktok-upload.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

// OAuth — el callback viene de TikTok (sin JWT)
router.get('/api/tiktok/auth/url',      verifyToken, getAuthUrl);
router.get('/api/tiktok/auth/callback', handleCallback);
router.get('/api/tiktok/auth/status',   verifyToken, getAuthStatus);
router.delete('/api/tiktok/auth',       verifyToken, revokeAuth);
router.get('/api/tiktok/creator-info',  verifyToken, getCreatorInfo);

// Upload
router.post('/api/tiktok/upload',       verifyToken, uploadToTikTok);

export default router;
