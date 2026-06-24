import { Request, Response } from 'express';
import mongoose from 'mongoose';

// Si el último heartbeat de esse-Transcrip es más viejo que esto, se considera inactivo.
// El worker de Python late cada ~5s, así que 90s da margen de sobra.
const HEARTBEAT_MAX_AGE_MS = 90 * 1000;

// ── GET /api/components/transcrip ─────────────────────────────────────────────
// Detecta si el componente esse-Transcrip (worker de transcripción) está activo.
export const getTranscripStatus = async (_req: Request, res: Response) => {
  try {
    const db  = mongoose.connection.db!;
    const doc = await db.collection('components').findOne({ name: 'esse-transcrip' });

    const lastHeartbeat = doc?.lastHeartbeat ? new Date(doc.lastHeartbeat) : null;
    const active = !!lastHeartbeat && (Date.now() - lastHeartbeat.getTime() < HEARTBEAT_MAX_AGE_MS);

    // Cuántos videos están esperando transcripción
    const pending = await db.collection('files').countDocuments({ status: 'PENDIENTE' });

    res.json({
      active,
      lastHeartbeat,
      version: doc?.version ?? null,
      pending,
    });
  } catch (err: any) {
    res.status(500).json({ active: false, error: err.message });
  }
};
