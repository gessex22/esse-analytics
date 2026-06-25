import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { verifyToken, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

// POST /api/local/wipe — limpia todas las colecciones locales
router.post('/api/local/wipe', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'todopoderoso') {
    res.status(403).json({ message: 'Solo el administrador puede hacer esto.' });
    return;
  }
  try {
    const db = mongoose.connection.db!;
    const results: Record<string, number> = {};

    const collections = ['files', 'publishing_status', 'platformvideos', 'platform_config', 'app_config'];
    for (const col of collections) {
      const r = await db.collection(col).deleteMany({});
      results[col] = r.deletedCount;
    }

    res.json({ ok: true, cleared: results });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al limpiar.', detail: err.message });
  }
});

// GET /api/local/health — indica que este es el local-backend
router.get('/api/local/health', (_req, res) => {
  res.json({ local: true, mongoState: mongoose.connection.readyState });
});

export default router;
