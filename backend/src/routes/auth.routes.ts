import { Router } from 'express';
import { login, me, getLoginLogs } from '../controllers/auth.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';
import { loginRateLimit } from '../middleware/rate-limit.middleware';

const router = Router();

router.post('/api/auth/login', loginRateLimit, login);
router.get('/api/auth/me', verifyToken, me);
router.get('/api/auth/logs', verifyToken, requireRole('todopoderoso'), getLoginLogs);

export default router;
