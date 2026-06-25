import { Router } from 'express';
import { register, login, me, getLoginLogs, clearLoginLogs, getUsers, setUserTier, deactivateMe, deactivateUser, localResetPassword, localDeactivate, linkInstall, setMyTheme } from '../controllers/auth.controller';
import { verifyToken, requireOwner } from '../middleware/auth.middleware';
import { loginRateLimit } from '../middleware/rate-limit.middleware';

const router = Router();

router.post('/api/auth/register',           loginRateLimit, register);
router.post('/api/auth/login',              loginRateLimit, login);
router.get('/api/auth/me',                  verifyToken, me);
router.post('/api/auth/me/deactivate',      verifyToken, deactivateMe);
router.post('/api/auth/link-install',       verifyToken, linkInstall);
router.post('/api/auth/me/theme',           verifyToken, setMyTheme);
router.get('/api/auth/logs',                verifyToken, requireOwner, getLoginLogs);
router.delete('/api/auth/logs',             verifyToken, requireOwner, clearLoginLogs);
router.get('/api/auth/users',               verifyToken, requireOwner, getUsers);
router.patch('/api/auth/users/:id/tier',       verifyToken, requireOwner, setUserTier);
router.patch('/api/auth/users/:id/deactivate', verifyToken, requireOwner, deactivateUser)
router.post('/api/auth/local-reset',                                        localResetPassword);
router.post('/api/auth/local-deactivate',                                   localDeactivate);

export default router;
