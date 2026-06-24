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

// Lectura — libre
router.get('/', getTallerIdeas);

// Protegidas — solo todopoderoso
router.put('/:ideaId/set-main',              verifyToken, requireRole('todopoderoso'), setMainVersion);
router.patch('/:ideaId/status',              verifyToken, requireRole('todopoderoso'), updateIdeaStatus);
router.delete('/:ideaId',                    verifyToken, requireRole('todopoderoso'), deleteIdeaCentral);
router.delete('/:ideaId/videos/:videoId',    verifyToken, requireRole('todopoderoso'), deleteVideoIndividual);

export default router;
