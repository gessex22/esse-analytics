import { Router } from 'express';
import {
  register, login, me, setMyTheme, linkInstall, getUsers,
  setUserTier, setUserCloudStorage, deactivateUser, deactivateMe,
} from '../controllers/auth.controller';
import { verifyToken, requireOwner } from '../middleware/auth.middleware';
import { loginRateLimit, registerRateLimit } from '../middleware/rate-limit.middleware';

const router = Router();

router.post('/api/auth/register',      registerRateLimit, register);
router.post('/api/auth/login',         loginRateLimit, login);
router.get('/api/auth/me',             verifyToken, me);
router.post('/api/auth/me/theme',      verifyToken, setMyTheme);
router.post('/api/auth/me/deactivate', verifyToken, deactivateMe);
router.post('/api/auth/link-install',  verifyToken, linkInstall);
router.get('/api/auth/users',                     verifyToken, requireOwner, getUsers);
router.patch('/api/auth/users/:id/tier',          verifyToken, requireOwner, setUserTier);
router.patch('/api/auth/users/:id/cloud-storage', verifyToken, requireOwner, setUserCloudStorage);
router.patch('/api/auth/users/:id/deactivate',    verifyToken, requireOwner, deactivateUser);

export default router;
