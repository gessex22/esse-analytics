import { Router } from 'express';
import { fileRepo } from '../db/file.repo';
import path from 'path';
import fs from 'fs';
import { verifyTokenFromHeaderOrQuery, requireOwnerOrNoOwnerSet } from '../middleware/auth.middleware';

const router = Router();

// FIX 2026-08-16 (Fase 0, docs/lan-library-auto-switch-design-2026-08-16.md):
// ninguna de las 2 rutas de acá pedía NADA de auth antes -- cualquiera en la
// misma LAN que adivinara/enumerara un fileId podía reproducir o descargar
// el video de cualquier PC, sesión o no. AVURLAsset no manda headers custom,
// por eso verifyTokenFromHeaderOrQuery (acepta ?token=) en vez de verifyToken
// a secas -- mismo patrón que ya usa la central para sus streams equivalentes.
router.get('/api/videos/stream/:id', verifyTokenFromHeaderOrQuery, requireOwnerOrNoOwnerSet, async (req, res) => {
  try {
    const doc = fileRepo.findById(req.params.id as string);
    if (!doc || doc.status === 'ELIMINADO_DISCO') return res.status(404).json({ error: 'Video no disponible' });
    const filePath = path.resolve(doc.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });

    const stat     = fs.statSync(filePath);
    const fileSize = stat.size;
    const range    = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   'video/mp4',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch {
    res.status(500).json({ error: 'Error en el streaming' });
  }
});

router.get('/api/videos/download/:id', verifyTokenFromHeaderOrQuery, requireOwnerOrNoOwnerSet, async (req, res) => {
  try {
    const doc = fileRepo.findById(req.params.id as string);
    if (!doc || doc.status === 'ELIMINADO_DISCO') return res.status(404).json({ error: 'Video no disponible' });
    const filePath = path.resolve(doc.file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Length':      stat.size,
      'Content-Type':        'video/mp4',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.status(500).json({ error: 'Error al descargar' });
  }
});

export default router;
