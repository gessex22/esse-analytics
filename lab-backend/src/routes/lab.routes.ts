import { Router } from 'express';
import {
  getScenarios, applyScenarioHandler, listUsers, createOrUpdateUser, updateUser, deleteUser, reset, getRateLimits, resetMyRateLimits,
} from '../controllers/lab.controller';
import { getJobStatus, listJobsHandler, cancelJobHandler, retryJobHandler } from '../controllers/platform.controller';

// Sin verifyToken a propósito: es la herramienta de administración del propio
// Laboratorio (equivalente al panel admin.html), no un endpoint que consuma la
// app -- protegerlo con el JWT de un usuario mock sería circular (¿con qué
// cuenta te logueás para crear la primera cuenta?). Igual queda inalcanzable
// desde fuera del proceso salvo que alguien conozca la URL del Laboratorio en
// la LAN, y el propio servidor se niega a arrancar sin ESSENALYTICS_LAB_MODE=1.
const router = Router();

router.get('/api/lab/scenarios', getScenarios);
router.post('/api/lab/scenarios/:key/apply', applyScenarioHandler);

router.get('/api/lab/users', listUsers);
router.post('/api/lab/users', createOrUpdateUser);
router.patch('/api/lab/users/:id', updateUser);
router.delete('/api/lab/users/:id', deleteUser);

router.post('/api/lab/reset', reset);
router.get('/api/lab/rate-limits', getRateLimits);
router.post('/api/lab/rate-limits/reset', resetMyRateLimits);

router.get('/api/lab/publish-jobs', listJobsHandler);
router.get('/api/lab/publish-jobs/:id', getJobStatus);
router.post('/api/lab/publish-jobs/:id/cancel', cancelJobHandler);
router.post('/api/lab/publish-jobs/:id/retry', retryJobHandler);

export default router;
