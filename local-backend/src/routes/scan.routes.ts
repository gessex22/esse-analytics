import { Router } from 'express';
import { getScanConfig, updateScanConfig, scanFolder, autoDetectFolder } from '../controllers/scan.controller';
import { verifyToken, requirePrimaryDevice } from '../middleware/auth.middleware';

const router = Router();

// getScanConfig es de solo lectura (ver qué carpeta hay configurada) -- no
// gatea. Las 3 que escriben/escanean sí (docs/primary-install-corrected-plan-2026-08-14.md,
// Fase E): una secundaria no debe poder configurar ni escanear carpeta.
router.get('/api/videos/scan/config',  verifyToken, getScanConfig);
router.post('/api/videos/scan/config', verifyToken, requirePrimaryDevice, updateScanConfig);
router.post('/api/videos/scan',        verifyToken, requirePrimaryDevice, scanFolder);
router.post('/api/local/setup/auto-detect', verifyToken, requirePrimaryDevice, autoDetectFolder);

export default router;
