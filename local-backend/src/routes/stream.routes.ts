import { Router } from 'express';
import { fileRepo } from '../db/file.repo';
import path from 'path';
import fs from 'fs';

const router = Router();

router.get('/api/videos/stream/:id', async (req, res) => {
  try {
    const doc = fileRepo.findById(req.params.id);
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

router.get('/api/videos/download/:id', async (req, res) => {
  try {
    const doc = fileRepo.findById(req.params.id);
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
