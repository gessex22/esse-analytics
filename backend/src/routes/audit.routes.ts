import { Router } from 'express';
import { getAuditEvents } from '../controllers/audit.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

// Solo GET -- append-only a propósito (ver audit-event.model.ts), no hay
// rutas de escritura expuestas a clientes: los eventos los graba
// recordAuditEvent() server-side desde los controllers que ya manejan cada
// acción (login, connect/disconnect OAuth, publicar, calendario).
router.get('/api/audit-events', verifyToken, getAuditEvents);

export default router;
