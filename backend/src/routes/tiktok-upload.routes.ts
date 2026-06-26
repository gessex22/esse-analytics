import { Router } from 'express';
import {
  getAuthUrl,
  handleCallback,
  getAuthStatus,
  revokeAuth,
  getCreatorInfo,
  uploadToTikTok,
  getToken,
} from '../controllers/tiktok-upload.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

// OAuth — el callback viene de TikTok (sin JWT)
router.get('/api/tiktok/auth/url',      verifyToken, getAuthUrl);
router.get('/api/tiktok/auth/callback', handleCallback);
router.get('/api/tiktok/auth/status',   verifyToken, getAuthStatus);
router.delete('/api/tiktok/auth',       verifyToken, revokeAuth);
router.get('/api/tiktok/creator-info',  verifyToken, getCreatorInfo);

// Token para local-backend (no expone secret, solo access_token)
router.get('/api/tiktok/token',         verifyToken, getToken);

// Upload
router.post('/api/tiktok/upload',       verifyToken, uploadToTikTok);

export default router;
