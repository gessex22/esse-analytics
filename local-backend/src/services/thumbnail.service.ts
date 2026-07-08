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

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => resolve(err ? 0 : Number(data.format?.duration ?? 0)));
  });
}

/**
 * Genera (una sola vez) la miniatura JPG de un video y la cachea en disco — las
 * siguientes veces se sirve directo del archivo ya generado. Toma el frame al
 * 10% de la duración (tope 3s) en vez del frame 0, que en clips cortos suele
 * salir en negro o mostrando solo el logo/intro.
 */
export async function ensureThumbnail(
  fileId: string | number,
  videoPath: string,
  knownDurationSec?: number,
): Promise<string | null> {
  const out = thumbPath(fileId);
  if (fs.existsSync(out)) return out;

  try {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    const duration = knownDurationSec ?? await probeDuration(videoPath);
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

    return fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

// Se llama al borrar el archivo original — evita miniaturas huérfanas acumulándose.
export function deleteThumbnail(fileId: string | number): void {
  try { fs.unlinkSync(thumbPath(fileId)); } catch { /* no existía, no-op */ }
}
