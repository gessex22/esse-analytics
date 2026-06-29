import { Router } from 'express';
import { getScanConfig, updateScanConfig, scanFolder, autoDetectFolder } from '../controllers/scan.controller';
import { verifyToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/api/videos/scan/config',  verifyToken, getScanConfig);
router.post('/api/videos/scan/config', verifyToken, updateScanConfig);
router.post('/api/videos/scan',        verifyToken, scanFolder);
router.post('/api/local/setup/auto-detect', verifyToken, autoDetectFolder);

export default router;
