import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendDebugLog } from './video-normalize.service';

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

// v2: miniatura de tamaño fijo con fondo desenfocado rellenando los bordes en
// vez de recortar — un reel 9:16 ya no se ve cortado ni con barras negras
// dentro de la caja 16:9 de la lista. El sufijo de versión evita servir para
// siempre las .jpg viejas (recorte simple) ya generadas por versiones previas.
const THUMB_W = 320;
const THUMB_H = 180;

function thumbPath(fileId: string | number): string {
  return path.join(THUMBS_DIR, `${fileId}.v2.jpg`);
}

export interface ProbedVideoInfo {
  durationSec: number;
  width: number | null;
  height: number | null;
}

// Trae duración Y dimensiones en una sola pasada de ffprobe — se usa tanto
// para backfillear la duración como formato/resolución (antes solo se pedía
// duración, y formato/resolución quedaban en null hasta que el plugin de
// transcripción externo los calculaba, así que reels recién agregados se
// clasificaban por default como "16:9" al no tener con qué derivar 9:16).
export function probeVideoInfo(filePath: string): Promise<ProbedVideoInfo> {
  const name = path.basename(filePath);
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        appendDebugLog(`[thumb] ffprobe FALLÓ para "${name}": ${err.message}`);
        resolve({ durationSec: 0, width: null, height: null });
        return;
      }
      const video = data.streams.find(s => s.codec_type === 'video');
      resolve({
        durationSec: Number(data.format?.duration ?? 0),
        width:  video?.width  ?? null,
        height: video?.height ?? null,
      });
    });
  });
}

export interface ThumbnailResult {
  path: string | null;
  // Solo viene seteado cuando probamos el archivo porque faltaba algún dato
  // (duración, formato o resolución) — el caller persiste en la DB lo que
  // corresponda. Si ya se conocía todo, no se vuelve a probar.
  probed: ProbedVideoInfo | null;
}

/**
 * Genera (una sola vez) la miniatura JPG de un video y la cachea en disco — las
 * siguientes veces se sirve directo del archivo ya generado. Toma el frame al
 * 10% de la duración (tope 3s) en vez del frame 0, que en clips cortos suele
 * salir en negro o mostrando solo el logo/intro.
 *
 * De paso resuelve con ffprobe lo que no se conozca todavía (duración,
 * formato, resolución) — antes duración se estimaba por conteo de palabras
 * (siempre "0:15" fijo si no había transcripción) y formato/resolución
 * quedaban en null hasta que el plugin de transcripción externo los calculaba,
 * así que un reel (9:16) recién agregado se mostraba como "16:9" por default.
 */
export async function ensureThumbnail(
  fileId: string | number,
  videoPath: string,
  known: { durationSec?: number; hasDimensions?: boolean },
): Promise<ThumbnailResult> {
  const name = path.basename(videoPath);
  const out = thumbPath(fileId);
  const needsProbe = !known.durationSec || !known.hasDimensions;
  const probed = needsProbe ? await probeVideoInfo(videoPath) : null;
  const duration = known.durationSec ?? probed?.durationSec ?? 0;

  if (fs.existsSync(out)) return { path: out, probed };

  try {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    const offset = duration > 0 ? Math.min(3, duration * 0.1) : 1;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(offset)
        .complexFilter([
          // Fondo: llena el cuadro entero (recorta lo que sobre) y lo difumina fuerte.
          `[0:v]scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H},boxblur=20:5[bg]`,
          // Frente: entra completo sin recortar (letterbox), centrado sobre el fondo.
          `[0:v]scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease[fg]`,
          `[bg][fg]overlay=(W-w)/2:(H-h)/2[out]`,
        ], 'out')
        .outputOptions(['-frames:v', '1', '-update', '1'])
        .on('error', reject)
        .on('end', () => resolve())
        .save(out);
    });

    const ok = fs.existsSync(out);
    if (!ok) appendDebugLog(`[thumb] "${name}" → ffmpeg terminó sin error pero no generó el .jpg (offset=${offset.toFixed(1)}s)`);
    return { path: ok ? out : null, probed };
  } catch (err: any) {
    appendDebugLog(`[thumb] "${name}" → ffmpeg FALLÓ generando miniatura: ${err.message}`);
    return { path: null, probed };
  }
}

// Se llama al borrar el archivo original — evita miniaturas huérfanas acumulándose.
// Borra también el nombre viejo (sin .v2) por si quedó de una versión anterior.
export function deleteThumbnail(fileId: string | number): void {
  try { fs.unlinkSync(thumbPath(fileId)); } catch { /* no existía, no-op */ }
  try { fs.unlinkSync(path.join(THUMBS_DIR, `${fileId}.jpg`)); } catch { /* no existía, no-op */ }
}

// Se llama en el wipe (logout/cambio de cuenta/reset) — las miniaturas son
// datos derivados de LOS ARCHIVOS de la cuenta que se está desvinculando, no
// tiene sentido que sobrevivan al wipe de la base ni queden huérfanas ocupando
// espacio en disco para una cuenta que ya no está.
export function deleteAllThumbnails(): void {
  try { fs.rmSync(THUMBS_DIR, { recursive: true, force: true }); } catch { /* no existía, no-op */ }
}
