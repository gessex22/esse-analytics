import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import fs from 'fs';
import os from 'os';
import path from 'path';

// En la app empaquetada, server.cjs vive DENTRO de app.asar. ffmpeg-static/ffprobe-static
// (resueltos con require() desde ahí) devuelven una ruta que menciona ".../app.asar/...":
// en teoría Node no puede EJECUTAR un binario que vive dentro del archivo empaquetado, solo
// leerlo — probado con ELECTRON_RUN_AS_NODE contra el instalador real y, sorprendentemente,
// SÍ pudo ejecutarlo igual (Electron redirige internamente al real en app.asar.unpacked).
// O sea que esto NO explicó por qué el log seguía vacío en producción — se deja el fix
// igual (usar la ruta unpacked explícita no rompe nada) pero la causa real seguía sin
// confirmarse cuando se escribió este comentario. Ver logs de depuración más abajo.
function unpackAsarPath(p: string): string {
  return p.replace('app.asar', 'app.asar.unpacked');
}

ffmpeg.setFfmpegPath(unpackAsarPath(ffmpegPath as unknown as string));
ffmpeg.setFfprobePath(unpackAsarPath(ffprobeStatic.path));

// La app empaquetada corre server.cjs DENTRO del proceso principal de Electron
// (ver electron/src/main.ts) — console.log/warn no van a ningún lado visible sin
// terminal adjunta. Sin este archivo no hay forma de confirmar, en producción, si
// ffmpeg corrió, qué decidió (remux/transcode) o si falló y se subió el original.
const LOG_DIR  = process.env.SQLITE_DIR || path.join(os.homedir(), '.esse-analytics');
const LOG_PATH = path.join(LOG_DIR, 'ffmpeg-normalize.log');

// Exportado para que otros módulos (p.ej. instagram-upload.controller) escriban al mismo
// archivo — así se puede reconstruir la traza completa de una subida en un solo lugar.
export function appendDebugLog(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* el log es solo diagnóstico — nunca debe romper la subida */ }
}

function logResult(line: string): void {
  appendDebugLog(line);
}

function probe(filePath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function parseFrameRate(rate?: string): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n;
}

const MAX_WIDTH  = 1080;
const MAX_HEIGHT = 1920;
const MAX_FPS    = 30;

// Meta (Reels) rechaza silenciosamente ciertos videos con un genérico "ProcessingFailedError:
// Request processing failed" que no dice la causa real. Estos chequeos de codec/pixel format/
// audio/frame rate arreglan casos reales de incompatibilidad, PERO no son la causa principal
// de las fallas que motivaron esto: esa resultó ser la DURACIÓN (cuentas sin el permiso/rollout
// de Reels extendidos quedan topeadas a 60s vía la Content Publishing API, sin importar el
// encoding — confirmado con un video de 70s que seguía fallando ya normalizado, y que subió
// bien recién al recortarlo a 55s). El manejo de duración vive en uploadToInstagram (recorte
// escalonado), no acá — esta función solo arregla codec/resolución/bitrate.
function needsTranscode(data: ffmpeg.FfprobeData): boolean {
  const video = data.streams.find(s => s.codec_type === 'video');
  const audio = data.streams.find(s => s.codec_type === 'audio');
  if (!video) return true;
  if (video.codec_name !== 'h264') return true;
  if (video.pix_fmt !== 'yuv420p') return true;
  if (audio && audio.codec_name !== 'aac') return true;
  if ((video.width ?? 0) > MAX_WIDTH || (video.height ?? 0) > MAX_HEIGHT) return true;

  const declared = parseFrameRate(video.r_frame_rate);
  const real     = parseFrameRate(video.avg_frame_rate);
  if (declared != null && real != null && Math.abs(declared - real) > 0.5) return true;
  if (declared != null && declared > MAX_FPS) return true;

  return false;
}

export type NormalizeMode = 'transcode' | 'remux';

export interface NormalizeResult {
  outputPath: string;
  mode: NormalizeMode;
}

/**
 * Normaliza el video a un baseline que Meta acepta de forma confiable: H.264 + yuv420p +
 * AAC + moov atom al inicio (faststart). Si el archivo ya cumple, hace un remux barato
 * (stream copy) — solo re-codifica cuando hace falta, para no perder calidad ni tiempo
 * de más. Devuelve la ruta de un archivo temporal (el caller es responsable de borrarlo)
 * junto con el modo usado, para poder informarle al usuario si el video fue optimizado.
 */
export async function normalizeForMeta(filePath: string): Promise<NormalizeResult> {
  const start = Date.now();
  const name  = path.basename(filePath);
  let stage   = 'ffprobe'; // se actualiza a medida que avanza, para que el log diga DÓNDE falló

  try {
    const data  = await probe(filePath);
    const video = data.streams.find(s => s.codec_type === 'video');
    const audio = data.streams.find(s => s.codec_type === 'audio');
    const transcode = needsTranscode(data);
    const mode  = transcode ? 'transcode' : 'remux';
    stage = mode;

    const base = path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmpPath = path.join(os.tmpdir(), `esse-ig-${Date.now()}-${base}.mp4`);

    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(filePath);

      if (transcode) {
        cmd.videoCodec('libx264').outputOptions([
          '-pix_fmt', 'yuv420p',
          '-preset', 'veryfast',
          '-crf', '21',
          '-maxrate', '6M',
          '-bufsize', '12M',
          '-r', String(MAX_FPS),
          // Achica solo si excede el máximo (nunca agranda); force_divisible_by=2 porque
          // libx264 exige dimensiones pares.
          '-vf', `scale=min(iw\\,${MAX_WIDTH}):min(ih\\,${MAX_HEIGHT}):force_original_aspect_ratio=decrease:force_divisible_by=2`,
        ]);
        if (audio) cmd.audioCodec('aac').audioBitrate('128k');
        else cmd.noAudio();
      } else {
        cmd.outputOptions(['-c copy']);
      }

      cmd
        .outputOptions(['-movflags +faststart'])
        .on('error', (err) => reject(err))
        .on('end', () => resolve())
        .save(tmpPath);
    });

    const secs = ((Date.now() - start) / 1000).toFixed(1);
    const res  = video ? `${video.width}x${video.height}@${parseFrameRate(video.r_frame_rate) ?? '?'}fps` : '?';
    logResult(`${name} → ${mode} (video=${video?.codec_name ?? '?'}/${video?.pix_fmt ?? '?'} ${res}, audio=${audio?.codec_name ?? 'ninguno'}) → OK en ${secs}s`);
    return { outputPath: tmpPath, mode };
  } catch (err: any) {
    // Cubre CUALQUIER falla (incluso si ffprobe/ffmpeg nunca pudieron correr, p.ej. por
    // resolución de ruta al binario dentro de la app empaquetada) — antes, un error acá
    // se escapaba sin dejar rastro en el log (solo un console.warn invisible en producción).
    logResult(`${name} → FALLÓ en etapa "${stage}" (${err.message}) — se sube el archivo original`);
    throw err;
  }
}

export const META_MAX_DURATION_SEC = 60;

/**
 * Recorta el video a durationSec segundos (tope META_MAX_DURATION_SEC — nunca más largo,
 * puede ser más corto), empezando en startSec (ajustado para no pasarse del final). Stream
 * copy (sin re-codificar) — rápido, aunque el corte puede caer a mitad de un GOP y perder un
 * frame o dos de precisión; es aceptable para este uso. Se usa como 2do intento cuando Meta
 * rechaza el video completo (ver uploadToInstagram).
 */
export async function trimToMaxDuration(filePath: string, startSec = 0, durationSec = META_MAX_DURATION_SEC): Promise<string> {
  const name = path.basename(filePath);
  const clip = Math.min(Math.max(1, durationSec), META_MAX_DURATION_SEC);
  try {
    const data = await probe(filePath);
    const duration = Number(data.format?.duration ?? 0);
    const maxStart = Math.max(0, duration - clip);
    const safeStart = Math.min(Math.max(0, startSec), maxStart);

    const base = path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmpPath = path.join(os.tmpdir(), `esse-ig-trim-${Date.now()}-${base}.mp4`);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(filePath)
        .setStartTime(safeStart)
        .duration(clip)
        .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart'])
        .on('error', (err) => reject(err))
        .on('end', () => resolve())
        .save(tmpPath);
    });

    logResult(`${name} → recorte a ${clip}s desde ${safeStart.toFixed(1)}s (de ${duration.toFixed(1)}s) → OK`);
    return tmpPath;
  } catch (err: any) {
    logResult(`${name} → recorte FALLÓ (${err.message})`);
    throw err;
  }
}
