import { Router } from 'express';
import {
  getAuthUrl,
  handleCallback,
  getAuthStatus,
  revokeAuth,
  getCreatorInfo,
  uploadToTikTok,
} from '../controllers/tiktok-upload.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/tiktok/auth/url',      verifyToken, requireRole('todopoderoso'), getAuthUrl);
router.get('/api/tiktok/auth/callback', handleCallback);
router.get('/api/tiktok/auth/status',   verifyToken, getAuthStatus);
router.delete('/api/tiktok/auth',       verifyToken, requireRole('todopoderoso'), revokeAuth);
router.get('/api/tiktok/creator-info',  verifyToken, requireRole('todopoderoso'), getCreatorInfo);
router.post('/api/tiktok/upload',       verifyToken, requireRole('todopoderoso'), uploadToTikTok);

export default router;
