import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { fileRepo } from './db/file.repo';
import { configRepo } from './db/config.repo';
import { pluginStatus, startPlugin } from './plugins';

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
      if (added || restored) scheduleTranscription();
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

// Muchos editores (CapCut, Premiere, ffmpeg) escriben primero a un archivo
// temporal (nombre random tipo UUID) y al terminar lo renombran al nombre
// final. Para chokidar eso son dos eventos sueltos: unlink del temporal +
// add del final. Sin esto, quedan dos filas para el mismo video (una
// ELIMINADO_DISCO fantasma y otra nueva). Detectamos el rename emparejando
// por tamaño de archivo dentro de una ventana corta.
const RENAME_GRACE_MS = 4_000;
const lastKnownSize = new Map<string, number>(); // absPath -> tamaño en bytes
const pendingRemovals = new Map<string, { fileId: number; size: number; timer: NodeJS.Timeout }>();

// Varios videos suelen llegar juntos (copia en lote): esperamos una pausa sin
// archivos nuevos antes de disparar la transcripción, para procesarlos de una.
const TRANSCRIP_DEBOUNCE_MS = 10_000;
let transcripTimer: NodeJS.Timeout | null = null;

function scheduleTranscription(): void {
  if (pluginStatus('esse_transcrip') !== 'installed') return; // no instalado o ya corriendo
  if (transcripTimer) clearTimeout(transcripTimer);
  transcripTimer = setTimeout(() => {
    transcripTimer = null;
    console.log('[watcher] Disparando esse_transcrip por video(s) nuevo(s)...');
    startPlugin('esse_transcrip');
  }, TRANSCRIP_DEBOUNCE_MS);
}

function onAdd(filePath: string): void {
  if (!isVideo(filePath)) return;
  const absPath = path.resolve(filePath);

  let size: number | null = null;
  let fechaCreacion: Date;
  try {
    const stat = fs.statSync(absPath);
    size = stat.size;
    fechaCreacion = stat.mtime;
  } catch { fechaCreacion = new Date(); }
  if (size !== null) lastKnownSize.set(absPath, size);

  // ¿Es el destino de un rename que acabamos de ver como unlink? (mismo tamaño,
  // borrado hace instantes). Si es así, actualizamos esa fila en vez de crear una nueva.
  if (size !== null) {
    for (const [oldPath, pending] of pendingRemovals) {
      if (pending.size === size) {
        clearTimeout(pending.timer);
        pendingRemovals.delete(oldPath);
        fileRepo.update(pending.fileId, { file_name: path.basename(absPath), file_path: absPath });
        console.log(`[watcher] Rename detectado: ${path.basename(oldPath)} -> ${path.basename(absPath)}`);
        return;
      }
    }
  }

  const { rows } = fileRepo.findAll({ search: path.basename(absPath), limit: 10, offset: 0 });
  const existing = rows.find(r => path.resolve(r.file_path) === absPath);
  if (!existing) {
    fileRepo.create({
      file_name: path.basename(absPath),
      file_path: absPath,
      status: 'PENDIENTE',
      content_status: 'borrador',
      platforms: [],
      fecha_creacion: fechaCreacion,
    });
    console.log(`[watcher] Nuevo video detectado: ${path.basename(absPath)}`);
    scheduleTranscription();
  } else if (existing.status === 'ELIMINADO_DISCO') {
    fileRepo.update(existing.id, { status: 'PENDIENTE' });
    console.log(`[watcher] Video restaurado: ${path.basename(absPath)}`);
    scheduleTranscription();
  }
}

function onUnlink(filePath: string): void {
  if (!isVideo(filePath)) return;
  const absPath = path.resolve(filePath);
  const size = lastKnownSize.get(absPath);
  lastKnownSize.delete(absPath);

  const { rows } = fileRepo.findAll({ search: path.basename(absPath), limit: 10, offset: 0 });
  const existing = rows.find(r => path.resolve(r.file_path) === absPath);
  if (!existing || existing.status === 'ELIMINADO_DISCO') return;

  if (size === undefined) {
    fileRepo.update(existing.id, { status: 'ELIMINADO_DISCO' });
    console.log(`[watcher] Video eliminado del disco: ${path.basename(absPath)}`);
    return;
  }

  // No lo marcamos eliminado todavía: puede ser un rename (el add del nombre
  // final puede llegar unos ms/segundos después). Si nadie lo reclama en
  // RENAME_GRACE_MS, recién ahí se confirma como borrado real.
  const timer = setTimeout(() => {
    pendingRemovals.delete(absPath);
    fileRepo.update(existing.id, { status: 'ELIMINADO_DISCO' });
    console.log(`[watcher] Video eliminado del disco: ${path.basename(absPath)}`);
  }, RENAME_GRACE_MS);
  pendingRemovals.set(absPath, { fileId: existing.id, size, timer });
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
  for (const pending of pendingRemovals.values()) clearTimeout(pending.timer);
  pendingRemovals.clear();
  lastKnownSize.clear();
  if (transcripTimer) { clearTimeout(transcripTimer); transcripTimer = null; }
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
