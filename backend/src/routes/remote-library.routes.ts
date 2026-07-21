import { Router } from 'express';
import {
  handleRemoteLibraryTus,
  remoteLibraryThumbnailUploadMiddleware,
  uploadRemoteLibraryThumbnail,
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

// Subida del video vía TUS (resumable) -- un solo handler para POST (crear),
// HEAD/PATCH (continuar chunks) y DELETE (cancelar). El gate de Express corre
// en cada request, incluidos los PATCH intermedios (el cliente TUS reenvía el
// mismo Authorization header en cada chunk).
router.all('/api/remote-library/tus', verifyToken, requireCloudStorage, handleRemoteLibraryTus);
router.all('/api/remote-library/tus/:id', verifyToken, requireCloudStorage, handleRemoteLibraryTus);

router.post('/api/remote-library/videos/:id/thumbnail', verifyToken, requireCloudStorage, remoteLibraryThumbnailUploadMiddleware, uploadRemoteLibraryThumbnail);
router.get('/api/remote-library/videos', verifyToken, requireCloudStorage, listRemoteLibraryVideos);
// verifyTokenFromHeaderOrQuery, no verifyToken a secas: para poder usarse
// directo como URL de descarga/streaming (mismo criterio que stream.routes.ts).
router.get('/api/remote-library/videos/:id/stream', verifyTokenFromHeaderOrQuery, requireCloudStorage, streamRemoteLibraryVideo);
router.get('/api/remote-library/videos/:id/thumbnail', verifyTokenFromHeaderOrQuery, requireCloudStorage, getRemoteLibraryThumbnail);
router.patch('/api/remote-library/videos/:id', verifyToken, requireCloudStorage, updateRemoteLibraryVideoPlatforms);
router.delete('/api/remote-library/videos/:id', verifyToken, requireCloudStorage, deleteRemoteLibraryVideo);

export default router;
