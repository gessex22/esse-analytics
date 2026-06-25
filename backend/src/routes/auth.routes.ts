import { Router } from 'express';
import { login, me, getLoginLogs, clearLoginLogs, getUsers, setUserTier } from '../controllers/auth.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';
import { loginRateLimit } from '../middleware/rate-limit.middleware';

const router = Router();

router.post('/api/auth/login',              loginRateLimit, login);
router.get('/api/auth/me',                  verifyToken, me);
router.get('/api/auth/logs',                verifyToken, requireRole('todopoderoso'), getLoginLogs);
router.delete('/api/auth/logs',             verifyToken, requireRole('todopoderoso'), clearLoginLogs);
router.get('/api/auth/users',               verifyToken, requireRole('todopoderoso'), getUsers);
router.patch('/api/auth/users/:id/tier',    verifyToken, requireRole('todopoderoso'), setUserTier);

export default router;
