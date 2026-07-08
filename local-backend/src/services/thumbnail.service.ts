import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Ver mismo fix en video-normalize.service.ts: en la app empaquetada hay que
// apuntar a la ruta unpacked, si no Node no puede ejecutar el binario dentro del asar.
function unpackAsarPath(p: string): string {
  return p.replace('app.asar', 'app.asar.unpacked');
}
ffmpeg.setFfmpegPath(unpackAsarPath(ffmpegPath as unknown as string));
ffmpeg.setFfprobePath(unpackAsarPath(ffprobeStatic.path));

// 100% local por ahora: las miniaturas viven en esta PC, no se suben a la nube
// ni se mandan a la central — evita costo de storage/transferencia mientras no
// haga falta mostrarlas fuera de esta instalación.
const THUMBS_DIR = path.join(process.env.SQLITE_DIR || path.join(os.homedir(), '.esse-analytics'), 'thumbnails');

function thumbPath(fileId: string | number): string {
  return path.join(THUMBS_DIR, `${fileId}.jpg`);
}

export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => resolve(err ? 0 : Number(data.format?.duration ?? 0)));
  });
}

export interface ThumbnailResult {
  path: string | null;
  // Solo viene seteado cuando tuvimos que probar el archivo porque no había
  // duracion_segundos guardada — el caller la persiste en la DB. Si ya se
  // pasó knownDurationSec, no se vuelve a probar (ya está resuelta).
  probedDurationSec: number | null;
}

/**
 * Genera (una sola vez) la miniatura JPG de un video y la cachea en disco — las
 * siguientes veces se sirve directo del archivo ya generado. Toma el frame al
 * 10% de la duración (tope 3s) en vez del frame 0, que en clips cortos suele
 * salir en negro o mostrando solo el logo/intro.
 *
 * De paso resuelve la duración real con ffprobe cuando no se conoce todavía
 * (video recién agregado, antes de que el plugin de transcripción la calcule) —
 * evita el estimado por conteo de palabras que mostraba "0:15" por defecto.
 */
export async function ensureThumbnail(
  fileId: string | number,
  videoPath: string,
  knownDurationSec?: number,
): Promise<ThumbnailResult> {
  const out = thumbPath(fileId);
  const needsDuration = !knownDurationSec;
  const probedDurationSec = needsDuration ? await probeDuration(videoPath) : null;
  const duration = knownDurationSec ?? probedDurationSec ?? 0;

  if (fs.existsSync(out)) return { path: out, probedDurationSec };

  try {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    const offset = duration > 0 ? Math.min(3, duration * 0.1) : 1;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .on('error', reject)
        .on('end', () => resolve())
        .screenshots({
          timestamps: [offset],
          filename:   path.basename(out),
          folder:     THUMBS_DIR,
          size:       '480x?',
        });
    });

    return { path: fs.existsSync(out) ? out : null, probedDurationSec };
  } catch {
    return { path: null, probedDurationSec };
  }
}

// Se llama al borrar el archivo original — evita miniaturas huérfanas acumulándose.
export function deleteThumbnail(fileId: string | number): void {
  try { fs.unlinkSync(thumbPath(fileId)); } catch { /* no existía, no-op */ }
}

// Se llama en el wipe (logout/cambio de cuenta/reset) — las miniaturas son
// datos derivados de LOS ARCHIVOS de la cuenta que se está desvinculando, no
// tiene sentido que sobrevivan al wipe de la base ni queden huérfanas ocupando
// espacio en disco para una cuenta que ya no está.
export function deleteAllThumbnails(): void {
  try { fs.rmSync(THUMBS_DIR, { recursive: true, force: true }); } catch { /* no existía, no-op */ }
}
