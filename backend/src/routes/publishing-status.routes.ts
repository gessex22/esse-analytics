import { Router } from 'express';
import { getAllPublishingStatus, updatePublishingStatus } from '../controllers/publishingStatus.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

// LEGACY (2026-08-13): sin consumidores en el frontend, ver
// publishingStatus.controller.ts. No agregar nuevos usos.
// Antes era pública sin token — cualquiera podía leer qué publicó cualquier usuario.
router.get('/api/publishing-status', verifyToken, getAllPublishingStatus);
router.patch('/api/publishing-status/:fileId', verifyToken, requireRole('todopoderoso'), updatePublishingStatus);

export default router;
