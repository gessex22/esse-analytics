import { Router } from 'express';
import {
  getTallerIdeas,
  setMainVersion,
  deleteVideoIndividual,
  deleteIdeaCentral,
  updateIdeaStatus
} from '../controllers/idea.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

// Lectura — antes era pública sin token, cualquiera podía leer las ideas de
// cualquier usuario. Ahora requiere sesión (el scoping por dueño lo hace el
// controller con req.user.id).
router.get('/', verifyToken, getTallerIdeas);

// Protegidas — solo todopoderoso
router.put('/:ideaId/set-main',              verifyToken, requireRole('todopoderoso'), setMainVersion);
router.patch('/:ideaId/status',              verifyToken, requireRole('todopoderoso'), updateIdeaStatus);
router.delete('/:ideaId',                    verifyToken, requireRole('todopoderoso'), deleteIdeaCentral);
router.delete('/:ideaId/videos/:videoId',    verifyToken, requireRole('todopoderoso'), deleteVideoIndividual);

export default router;
