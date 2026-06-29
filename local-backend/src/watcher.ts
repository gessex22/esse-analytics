import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { fileRepo } from './db/file.repo';
import { configRepo } from './db/config.repo';

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

// Escanea la carpeta en background para reconciliar lo que cambió mientras la
// app estuvo cerrada (archivos nuevos, restaurados o eliminados del disco).
function runScanInBackground(folder: string): void {
  setImmediate(() => {
    try {
      const diskPaths = walkVideos(folder);
      const diskSet   = new Set(diskPaths.map(p => path.resolve(p)));
      const { rows: existing } = fileRepo.findAll({ content_status: 'ALL' as any });
      const byPath = new Map(existing.map(f => [path.resolve(f.file_path), f]));

      let added = 0, restored = 0, missing = 0;

      for (const absPath of diskSet) {
        const known = byPath.get(absPath);
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
        } else if (known.status === 'ELIMINADO_DISCO') {
          fileRepo.update(known.id, { status: 'PENDIENTE' });
          restored++;
        }
      }

      for (const [absPath, known] of byPath) {
        if (!diskSet.has(absPath) && known.status !== 'ELIMINADO_DISCO') {
          fileRepo.update(known.id, { status: 'ELIMINADO_DISCO' });
          missing++;
        }
      }

      if (added || restored || missing) {
        console.log(`[watcher] Scan inicial: +${added} nuevos, ${restored} restaurados, ${missing} eliminados`);
      }
    } catch (err: any) {
      console.warn('[watcher] Error en scan inicial:', err.message);
    }
  });
}

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

/** Arranca el watcher al iniciar el servidor y escanea cambios offline. */
export function initWatcherFromConfig(): void {
  const folder = configRepo.get('videos_dir') ?? process.env.VIDEOS_DIR ?? null;
  if (!folder) return;
  startWatcher(folder);
  runScanInBackground(folder);
}
