import { Router, Response } from 'express';
import { verifyToken, AuthRequest } from '../middleware/auth.middleware';
import { configRepo } from '../db/config.repo';

const router = Router();

// POST /api/local/wipe — limpia todas las tablas locales
router.post('/api/local/wipe', verifyToken, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'todopoderoso') {
    res.status(403).json({ message: 'Solo el administrador puede hacer esto.' });
    return;
  }
  try {
    const results = configRepo.wipeAll();
    res.json({ ok: true, cleared: results });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al limpiar.', detail: err.message });
  }
});

// GET /api/local/owner — quién posee esta instancia (null si nadie aún)
router.get('/api/local/owner', (_req, res) => {
  try {
    const owner = configRepo.getOwner();
    res.json({ username: owner?.username ?? null });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al leer owner.', detail: err.message });
  }
});

// POST /api/local/owner — fija el owner tras el primer login
router.post('/api/local/owner', verifyToken, (req: AuthRequest, res: Response) => {
  try {
    const existing = configRepo.getOwner();
    if (existing && existing.username !== req.user!.username) {
      res.status(409).json({ message: 'Esta instancia ya está vinculada a otra cuenta.' });
      return;
    }
    configRepo.setOwner(req.user!.username);
    res.json({ ok: true, username: req.user!.username });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al fijar owner.', detail: err.message });
  }
});

// DELETE /api/local/owner — libera la instancia
router.delete('/api/local/owner', verifyToken, (req: AuthRequest, res: Response) => {
  try {
    const existing = configRepo.getOwner();
    if (existing && existing.username !== req.user!.username) {
      res.status(403).json({ message: 'Solo el dueño de esta instancia puede liberarla.' });
      return;
    }
    configRepo.clearOwner();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al liberar owner.', detail: err.message });
  }
});

// GET /api/local/health
router.get('/api/local/health', (_req, res) => {
  res.json({ local: true, db: 'sqlite' });
});

export default router;
