import { Router } from 'express';
import {
  getVideos, getVideoSlimList, getVideoSlimPendingTranscript, getVideoPlayerData,
  updateVideoContentStatus, updateVideoPlatforms, updateVideosBulk, resolvePublicationSelection,
  renameVideo, deleteFileFromDisk, getMetrics, updateScheduledDate, getVideoThumbnail,
  resolveFilesByName, getPlatformLinks, setPlatformLink, getCalendarVideos, pushVideoToCloud,
} from '../controllers/video.controller';
import { verifyToken, requireOwnerOrNoOwnerSet, verifyTokenFromHeaderOrQuery } from '../middleware/auth.middleware';

const router = Router();

// requireOwnerOrNoOwnerSet (docs/lan-library-auto-switch-design-2026-08-16.md,
// Fase 0): estas 3 son justo las que "Biblioteca LAN" auto-descubre y
// consulta sin que el usuario haya tipeado nada a mano -- verifyToken solo
// prueba que el JWT sea válido de ALGUNA cuenta, no que sea la dueña de
// ESTA PC.
router.get('/api/videos',                              verifyToken, requireOwnerOrNoOwnerSet, getVideos);
// Sin verifyToken: las consume esse_transcrip.py (proceso local, sin sesión de usuario),
// igual que /api/videos/:id/transcript y el resto de rutas plugin-facing.
router.get('/api/videos/slim',                         getVideoSlimList);
router.post('/api/videos/resolve-by-name',             verifyToken, resolveFilesByName);
router.get('/api/videos/slim/pending-transcript',      getVideoSlimPendingTranscript);
router.get('/api/metrics',                             verifyToken, requireOwnerOrNoOwnerSet, getMetrics);
router.get('/api/calendar',                            verifyToken, requireOwnerOrNoOwnerSet, getCalendarVideos);
router.get('/api/videos/:fileId/player-data',          verifyToken, getVideoPlayerData);
// FIX 2026-08-16 (Fase 0 del diseño de Biblioteca LAN): antes esto no pedía
// NADA de auth ("<img src> no puede mandar headers custom") -- cualquiera en
// la LAN que adivinara un fileId podía ver la miniatura de cualquier PC, sin
// sesión ni nada. Pasa a aceptar el JWT por query param (?token=, mismo
// patrón que RemoteLibraryAPI.thumbnailURL/streamURL ya usan contra la
// central) + el mismo chequeo de dueño que las rutas de arriba.
router.get('/api/videos/:fileId/thumbnail',            verifyTokenFromHeaderOrQuery, requireOwnerOrNoOwnerSet, getVideoThumbnail);
router.patch('/api/videos/:fileId/rename',             verifyToken, renameVideo);
router.patch('/api/videos/:fileId/status',             verifyToken, updateVideoContentStatus);
router.patch('/api/videos/:fileId/platforms',          verifyToken, updateVideoPlatforms);
router.post('/api/videos/:fileId/publication-selection', verifyToken, resolvePublicationSelection);
router.get('/api/videos/:fileId/platform-links',       verifyToken, getPlatformLinks);
router.patch('/api/videos/:fileId/platform-link/:platform', verifyToken, setPlatformLink);
router.patch('/api/videos/bulk',                       verifyToken, updateVideosBulk);
router.patch('/api/videos/:fileId/scheduled-date',     verifyToken, updateScheduledDate);
router.delete('/api/videos/:fileId/delete-file',       verifyToken, deleteFileFromDisk);
router.post('/api/videos/:fileId/push-to-cloud',       verifyToken, pushVideoToCloud);

export default router;
