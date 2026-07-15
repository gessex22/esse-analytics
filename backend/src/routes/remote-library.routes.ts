import { Router } from 'express';
import {
  remoteLibraryUploadMiddleware,
  uploadRemoteLibraryVideo,
  listRemoteLibraryVideos,
  streamRemoteLibraryVideo,
  getRemoteLibraryThumbnail,
  updateRemoteLibraryVideoPlatforms,
  deleteRemoteLibraryVideo,
} from '../controllers/remote-library.controller';
import { verifyToken, verifyTokenFromHeaderOrQuery, requireCloudStorage } from '../middleware/auth.middleware';

const router = Router();

// requireCloudStorage (Premium + entitlement de storage aparte, ver Parte D
// del plan) -- generalizado desde requireOwner: el owner sigue pasando por
// el short-circuit de isOwner() dentro de requireCloudStorage, cero
// regresión para la "instalación remota" original.
router.post('/api/remote-library/videos', verifyToken, requireCloudStorage, remoteLibraryUploadMiddleware, uploadRemoteLibraryVideo);
router.get('/api/remote-library/videos', verifyToken, requireCloudStorage, listRemoteLibraryVideos);
// verifyTokenFromHeaderOrQuery, no verifyToken a secas: para poder usarse
// directo como URL de descarga/streaming (mismo criterio que stream.routes.ts).
router.get('/api/remote-library/videos/:id/stream', verifyTokenFromHeaderOrQuery, requireCloudStorage, streamRemoteLibraryVideo);
router.get('/api/remote-library/videos/:id/thumbnail', verifyTokenFromHeaderOrQuery, requireCloudStorage, getRemoteLibraryThumbnail);
router.patch('/api/remote-library/videos/:id', verifyToken, requireCloudStorage, updateRemoteLibraryVideoPlatforms);
router.delete('/api/remote-library/videos/:id', verifyToken, requireCloudStorage, deleteRemoteLibraryVideo);

export default router;
