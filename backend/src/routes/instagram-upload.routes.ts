import { Router } from 'express';
import {
  getAuthUrl,
  handleCallback,
  getAuthStatus,
  revokeAuth,
  uploadToInstagram,
  getAccountInfo,
  debugAccount,
  getToken,
} from '../controllers/instagram-upload.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

// OAuth — el callback viene de Meta (sin JWT)
router.get('/api/instagram/auth/url',      verifyToken, getAuthUrl);
router.get('/api/instagram/auth/callback', handleCallback);
router.get('/api/instagram/auth/status',   verifyToken, getAuthStatus);
router.delete('/api/instagram/auth',       verifyToken, revokeAuth);
router.get('/api/instagram/account-info',  verifyToken, getAccountInfo);

// Token para local-backend
router.get('/api/instagram/token',         verifyToken, getToken);

// Upload
router.post('/api/instagram/upload',       verifyToken, uploadToInstagram);

// Debug (TEMPORAL)
router.get('/api/instagram/debug',         debugAccount);

export default router;
