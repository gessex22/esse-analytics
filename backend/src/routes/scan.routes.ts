import { Router } from 'express';
import { getScanConfig, updateScanConfig, scanFolder } from '../controllers/scan.controller';
import { verifyToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/videos/scan/config',  verifyToken, requireRole('todopoderoso'), getScanConfig);
router.post('/api/videos/scan/config', verifyToken, requireRole('todopoderoso'), updateScanConfig);
router.post('/api/videos/scan',        verifyToken, requireRole('todopoderoso'), scanFolder);

export default router;
