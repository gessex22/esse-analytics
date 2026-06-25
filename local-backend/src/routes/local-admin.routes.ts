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

// ── Owner local: una sola cuenta "posee" esta instalación ─────────────────────
// Se guarda en la colección local_config { key: 'owner', username }.

// GET /api/local/owner — quién posee esta instancia (null si nadie aún)
router.get('/api/local/owner', async (_req, res) => {
  try {
    const db = mongoose.connection.db!;
    const doc = await db.collection('local_config').findOne({ key: 'owner' });
    res.json({ username: doc?.username ?? null });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al leer owner.', detail: err.message });
  }
});

// POST /api/local/owner — fija el owner tras el primer login (requiere sesión)
router.post('/api/local/owner', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const db = mongoose.connection.db!;
    const existing = await db.collection('local_config').findOne({ key: 'owner' });
    // Solo se fija si no hay owner, o si es el mismo usuario re-confirmando
    if (existing && existing.username !== req.user!.username) {
      res.status(409).json({ message: 'Esta instancia ya está vinculada a otra cuenta.' });
      return;
    }
    await db.collection('local_config').updateOne(
      { key: 'owner' },
      { $set: { key: 'owner', username: req.user!.username, linkedAt: new Date() } },
      { upsert: true },
    );
    res.json({ ok: true, username: req.user!.username });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al fijar owner.', detail: err.message });
  }
});

// DELETE /api/local/owner — libera la instancia (cambiar de cuenta)
router.delete('/api/local/owner', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const db = mongoose.connection.db!;
    const existing = await db.collection('local_config').findOne({ key: 'owner' });
    if (existing && existing.username !== req.user!.username) {
      res.status(403).json({ message: 'Solo el dueño de esta instancia puede liberarla.' });
      return;
    }
    await db.collection('local_config').deleteOne({ key: 'owner' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al liberar owner.', detail: err.message });
  }
});

// GET /api/local/health — indica que este es el local-backend
router.get('/api/local/health', (_req, res) => {
  res.json({ local: true, mongoState: mongoose.connection.readyState });
});

export default router;
