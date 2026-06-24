import { Router } from 'express';
import { FileModel } from '../models/file.model';
import path from 'path';
import fs from 'fs';

const router = Router();

router.get('/api/videos/download/:id', async (req, res) => {
  try {
    const fileDoc = await FileModel.findById(req.params.id);
    if (!fileDoc || fileDoc.status === 'ELIMINADO_DISCO') {
      return res.status(404).json({ error: 'Video no disponible' });
    }

    const resolvedPath = path.resolve(fileDoc.file_path);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'Archivo no encontrado en PC' });
    }

    const stat     = fs.statSync(resolvedPath);
    const fileName = path.basename(resolvedPath);

    res.writeHead(200, {
      'Content-Length':      stat.size,
      'Content-Type':        'video/mp4',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
    });
    fs.createReadStream(resolvedPath).pipe(res);
  } catch {
    res.status(500).json({ error: 'Error al descargar' });
  }
});

router.get('/api/videos/stream/:id', async (req, res) => {
  try {
    const fileDoc = await FileModel.findById(req.params.id);
    if (!fileDoc || fileDoc.status === 'ELIMINADO_DISCO') {
      return res.status(404).json({ error: 'Video no disponible' });
    }

    const resolvedPath = path.resolve(fileDoc.file_path);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'Archivo no encontrado en PC' });
    }

    const stat = fs.statSync(resolvedPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(resolvedPath, { start, end });
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });
      file.pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
      fs.createReadStream(resolvedPath).pipe(res);
    }
  } catch (error) {
    res.status(500).json({ error: 'Error en el streaming' });
  }
});

export default router;