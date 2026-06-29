import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { fileRepo } from './db/file.repo';
import { configRepo } from './db/config.repo';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

let watcher: FSWatcher | null = null;
let watchedDir: string | null = null;

function isVideo(filePath: string): boolean {
  return VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
}

function onAdd(filePath: string): void {
  if (!isVideo(filePath)) return;
  const absPath = path.resolve(filePath);
  const { rows } = fileRepo.findAll({ search: path.basename(absPath), limit: 10, offset: 0 });
  const existing = rows.find(r => path.resolve(r.file_path) === absPath);
  if (!existing) {
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
    console.log(`[watcher] Nuevo video detectado: ${path.basename(absPath)}`);
  } else if (existing.status === 'ELIMINADO_DISCO') {
    fileRepo.update(existing.id, { status: 'PENDIENTE' });
    console.log(`[watcher] Video restaurado: ${path.basename(absPath)}`);
  }
}

function onUnlink(filePath: string): void {
  if (!isVideo(filePath)) return;
  const absPath = path.resolve(filePath);
  const { rows } = fileRepo.findAll({ search: path.basename(absPath), limit: 10, offset: 0 });
  const existing = rows.find(r => path.resolve(r.file_path) === absPath);
  if (existing && existing.status !== 'ELIMINADO_DISCO') {
    fileRepo.update(existing.id, { status: 'ELIMINADO_DISCO' });
    console.log(`[watcher] Video eliminado del disco: ${path.basename(absPath)}`);
  }
}

export function startWatcher(folder: string): void {
  if (watcher && watchedDir === folder) return; // ya vigilando esta carpeta
  stopWatcher();

  if (!fs.existsSync(folder)) {
    console.log(`[watcher] Carpeta no encontrada, no se inicia el watcher: ${folder}`);
    return;
  }

  watchedDir = folder;
  watcher = chokidar.watch(folder, {
    persistent: true,
    ignoreInitial: true,   // no re-procesar lo que ya está (eso lo hace scanFolder)
    recursive: true,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
  });

  watcher.on('add',    onAdd);
  watcher.on('unlink', onUnlink);
  watcher.on('error',  (err) => console.error('[watcher] Error:', err));

  console.log(`[watcher] Vigilando carpeta: ${folder}`);
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close().catch(() => {});
    watcher = null;
    watchedDir = null;
  }
}

export function restartWatcher(newFolder: string): void {
  stopWatcher();
  startWatcher(newFolder);
}

/** Arranca el watcher con la carpeta guardada en DB al iniciar el servidor. */
export function initWatcherFromConfig(): void {
  const folder = configRepo.get('videos_dir') ?? process.env.VIDEOS_DIR ?? null;
  if (folder) startWatcher(folder);
}
