import { Router } from 'express';
import {
  getAuthUrl,
  handleCallback,
  getAuthStatus,
  revokeAuth,
  getChannelInfo,
  uploadToYoutube,
  setThumbnail,
  remoteUploadToYoutube,
  remoteUploadMiddleware,
} from '../controllers/youtube-upload.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

// OAuth — el callback viene de Google (sin JWT)
router.get('/api/youtube/auth/url',           verifyToken, getAuthUrl);
router.get('/api/youtube/auth/callback',      handleCallback);
router.get('/api/youtube/auth/status',        verifyToken, getAuthStatus);
router.delete('/api/youtube/auth',            verifyToken, revokeAuth);
router.get('/api/youtube/channel-info',       verifyToken, getChannelInfo);

// Upload local (fileId en disco)
router.post('/api/youtube/upload',             verifyToken, uploadToYoutube);
// Upload remoto (archivo via multipart — free en LAN, premium en remoto)
router.post('/api/youtube/upload/remote',      verifyToken, remoteUploadMiddleware.single('video'), remoteUploadToYoutube);
router.post('/api/youtube/thumbnail/:videoId', verifyToken, setThumbnail);

export default router;
