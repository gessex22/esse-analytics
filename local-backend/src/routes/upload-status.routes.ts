import { Router } from 'express';
import { getAllUploadProgress } from '../state/upload-activity';

const router = Router();

// GET /api/upload-status — jobs de subida en curso (YouTube/Instagram/TikTok), poll liviano.
router.get('/api/upload-status', (_req, res) => {
  res.json(getAllUploadProgress());
});

export default router;
