import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileRepo } from '../db/file.repo';
import { configRepo } from '../db/config.repo';
import { restartWatcher } from '../watcher';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

function walkVideos(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkVideos(full, acc);
    else if (VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

export const getScanConfig = (_req: Request, res: Response) => {
  const dir = configRepo.get('videos_dir') ?? process.env.VIDEOS_DIR ?? null;
  res.json({ folder: dir, exists: dir ? fs.existsSync(dir) : false });
};

export const updateScanConfig = (req: Request, res: Response) => {
  const { folder } = req.body as { folder?: string };
  if (!folder) return res.status(400).json({ error: 'Debes indicar la ruta de la carpeta' });
  if (!fs.existsSync(folder)) return res.status(400).json({ error: 'La carpeta no existe en este equipo', folder });
  if (!fs.statSync(folder).isDirectory()) return res.status(400).json({ error: 'La ruta no es una carpeta', folder });
  configRepo.set('videos_dir', folder);
  restartWatcher(folder);
  res.json({ ok: true, folder });
};

export const scanFolder = (req: Request, res: Response) => {
  const folder = (req.body?.folder as string | undefined) || configRepo.get('videos_dir') || process.env.VIDEOS_DIR || null;
  if (!folder) return res.status(400).json({ error: 'No hay carpeta configurada.' });
  if (!fs.existsSync(folder)) return res.status(400).json({ error: 'La carpeta no existe', folder });

  const diskPaths = walkVideos(folder);
  const diskSet   = new Set(diskPaths.map(p => path.resolve(p)));

  // findAll without content_status filter to get all files including descartados
  const { rows: existing } = fileRepo.findAll({ content_status: 'ALL' as any });
  const existingByPath = new Map(existing.map(f => [path.resolve(f.file_path), f]));

  let added = 0, restored = 0, missing = 0, backfilled = 0;

  for (const absPath of diskSet) {
    const known = existingByPath.get(absPath);
    if (!known) {
      let fechaCreacion: Date;
      try { fechaCreacion = fs.statSync(absPath).mtime; } catch { fechaCreacion = new Date(); }
      fileRepo.create({
        file_name: path.basename(absPath),
        file_path: absPath,
        status: 'PENDIENTE',
        content_status: 'borrador',
        platforms: [],
        fecha_creacion: fechaCreacion,
      });
      added++;
    } else {
      if (known.status === 'ELIMINADO_DISCO') {
        fileRepo.update(known.id, { status: 'PENDIENTE' });
        restored++;
      }
      if (!known.fecha_creacion) {
        let fechaCreacion: Date;
        try { fechaCreacion = fs.statSync(absPath).mtime; } catch { fechaCreacion = new Date(); }
        fileRepo.update(known.id, { fecha_creacion: fechaCreacion });
        backfilled++;
      }
    }
  }

  for (const [absPath, known] of existingByPath) {
    if (!diskSet.has(absPath) && known.status !== 'ELIMINADO_DISCO') {
      fileRepo.update(known.id, { status: 'ELIMINADO_DISCO' });
      missing++;
    }
  }

  res.json({ ok: true, folder, scanned: diskSet.size, added, restored, missing, backfilled });
};
