import { Router } from 'express';
import {
  getAuthUrl,
  handleCallback,
  getAuthStatus,
  revokeAuth,
  uploadToInstagram,
  getAccountInfo,
  debugAccount,
} from '../controllers/instagram-upload.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/instagram/auth/url',      verifyToken, requireRole('todopoderoso'), getAuthUrl);
router.get('/api/instagram/auth/callback', handleCallback);
router.get('/api/instagram/auth/status',   verifyToken, getAuthStatus);
router.delete('/api/instagram/auth',       verifyToken, requireRole('todopoderoso'), revokeAuth);
router.post('/api/instagram/upload',       verifyToken, requireRole('todopoderoso'), uploadToInstagram);
router.get('/api/instagram/account-info', verifyToken, requireRole('todopoderoso'), getAccountInfo);
router.get('/api/instagram/debug',        debugAccount); // TEMPORAL: público para diagnóstico

export default router;
