import { Router } from 'express';
import { verifyToken } from '../middleware/auth.middleware';
import { connectionInfo, authStatus, getAuthUrl, getToken, disconnect, connect, startUpload } from '../controllers/platform.controller';

const router = Router();

// Nombres de path idénticos a los que ya usan backend/local-backend (ver
// backend/src/routes/*-upload.routes.ts, auth-proxy.routes.ts) -- solo cambia
// el host al que apunta el cliente, nunca el contrato.
router.get('/api/youtube/channel-info',     verifyToken, connectionInfo('youtube'));
router.get('/api/instagram/account-info',   verifyToken, connectionInfo('instagram'));
router.get('/api/tiktok/creator-info',      verifyToken, connectionInfo('tiktok'));

router.get('/api/youtube/auth/status',    verifyToken, authStatus('youtube'));
router.get('/api/instagram/auth/status',  verifyToken, authStatus('instagram'));
router.get('/api/tiktok/auth/status',     verifyToken, authStatus('tiktok'));

router.get('/api/youtube/auth/url',    verifyToken, getAuthUrl('youtube'));
router.get('/api/instagram/auth/url',  verifyToken, getAuthUrl('instagram'));
router.get('/api/tiktok/auth/url',     verifyToken, getAuthUrl('tiktok'));

router.get('/api/youtube/token',    verifyToken, getToken('youtube'));
router.get('/api/instagram/token',  verifyToken, getToken('instagram'));
router.get('/api/tiktok/token',     verifyToken, getToken('tiktok'));

router.delete('/api/youtube/auth',    verifyToken, disconnect('youtube'));
router.delete('/api/instagram/auth',  verifyToken, disconnect('instagram'));
router.delete('/api/tiktok/auth',     verifyToken, disconnect('tiktok'));

// Sin equivalente real (ahí es un handshake OAuth) -- ver comentario en
// platform.controller.ts::connect.
router.post('/api/youtube/auth/connect',    verifyToken, connect('youtube'));
router.post('/api/instagram/auth/connect',  verifyToken, connect('instagram'));
router.post('/api/tiktok/auth/connect',     verifyToken, connect('tiktok'));

// Uploaders mock -- ver publish-jobs.service.ts. Devuelven 202 + jobId;
// progreso/resultado se consulta en /api/lab/publish-jobs/:id (lab.routes.ts).
router.post('/api/youtube/upload',    verifyToken, startUpload('youtube'));
router.post('/api/instagram/upload',  verifyToken, startUpload('instagram'));
router.post('/api/tiktok/upload',     verifyToken, startUpload('tiktok'));

export default router;
