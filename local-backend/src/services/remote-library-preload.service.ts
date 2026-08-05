import fs from 'fs';
import { DbFile } from '../db/file.repo';
import { setPreloadActivity, clearPreloadActivity, setPreloadError } from '../state/remote-library-preload-activity';
import { ensureThumbnail } from './thumbnail.service';
import { normalizeForMeta, appendDebugLog } from './video-normalize.service';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
const DIRECT_UPLOAD_LIMIT = 80 * 1024 * 1024;
const TUS_CHUNK_SIZE = 8 * 1024 * 1024;
const ANDROID_MAX_WIDTH = 1080;
const ANDROID_MAX_HEIGHT = 1920;

function exceedsAndroidPlaybackLimit(resolution: unknown): boolean {
  const match = String(resolution ?? '').match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return false;
  return Number(match[1]) > ANDROID_MAX_WIDTH || Number(match[2]) > ANDROID_MAX_HEIGHT;
}

// Evita que dos disparadores simultáneos (montaje, foco, VideosView, etc.)
// suban el mismo archivo antes de que la central alcance a registrar el primero.
const inFlightByContentId = new Map<string, Promise<string | null>>();

async function lookupRemoteLibraryId(authHeader: string, contentId: string): Promise<string | null> {
  const res = await fetch(`${CENTRAL}/api/remote-library/videos/lookup?contentId=${encodeURIComponent(contentId)}`, {
    headers: { Authorization: authHeader },
  });
  // Un error de consulta no significa que el video no exista. Abortamos para
  // no convertir una caída temporal de la central en una subida duplicada.
  if (!res.ok) throw new Error(`No se pudo comprobar la Biblioteca remota (${res.status})`);
  const data = await res.json();
  if (!data.id) return null;

  // Defensa adicional mientras haya instalaciones centrales antiguas: el
  // endpoint lookup puede devolver un documento de catálogo sin bytes. Solo
  // consideramos precargado un video cuyo metadata confirma storedFileName.
  const detail = await fetch(`${CENTRAL}/api/remote-library/videos/${encodeURIComponent(String(data.id))}`, {
    headers: { Authorization: authHeader },
  });
  if (!detail.ok) return null;
  const detailData = await detail.json();
  // Si la copia remota fue subida antes del fix y conserva 1440x2560 (o una
  // resolución superior al límite del decodificador Android), devolvemos null
  // para que el caller la reemplace por una copia normalizada. El upsert por
  // contentId conserva el mismo documento, sus links y sus toggles.
  if (!detailData.video?.storedFileName) return null;
  if (exceedsAndroidPlaybackLimit(detailData.video?.resolution)) return null;
  return String(data.id);
}

async function uploadToRemoteLibrary(authHeader: string, file: DbFile): Promise<string | null> {
  // Algunos teléfonos Android (incluido el Oppo del diagnóstico) no aceptan
  // H.264 en 1440x2560 aunque iOS y el navegador sí. La copia normalizada se
  // usa únicamente para la Biblioteca remota; el original de la PC nunca se
  // modifica. normalizeForMeta solo recodifica cuando hace falta (p.ej. cuando
  // excede 1080x1920) y deja faststart/H.264/AAC compatibles.
  let uploadFile = file;
  let normalizedPath: string | null = null;
  try {
    const normalized = await normalizeForMeta(file.file_path);
    normalizedPath = normalized.outputPath;
    uploadFile = {
      ...file,
      file_path: normalized.outputPath,
      ...(normalized.mode === 'transcode' ? { resolucion: '1080x1920' } : {}),
    };
    appendDebugLog(`${file.file_name} -> Biblioteca remota usando copia ${normalized.mode} compatible con Android`);
  } catch (err: any) {
    // No bloquear la subida de la PC por una falla de ffmpeg. El diagnóstico
    // queda registrado y se conserva el comportamiento anterior como último
    // recurso.
    appendDebugLog(`${file.file_name} -> no se pudo normalizar para Android: ${err.message}; se sube original`);
  }

  try {
  const params = new URLSearchParams({ fileName: file.file_name, contentId: file.content_id ?? '' });
  if (uploadFile.duracion_segundos) params.set('durationSeconds', String(uploadFile.duracion_segundos));
  if (uploadFile.resolucion) params.set('resolution', uploadFile.resolucion);
  if (uploadFile.formato) params.set('formato', uploadFile.formato);

  const stat = fs.statSync(uploadFile.file_path);
  if (stat.size > DIRECT_UPLOAD_LIMIT) {
    const videoId = await uploadToRemoteLibraryTus(authHeader, uploadFile, stat.size);
    if (videoId) await uploadThumbnailToRemoteLibrary(authHeader, videoId, file);
    return videoId;
  }

  const res = await fetch(`${CENTRAL}/api/remote-library/videos/import?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size) },
    body: fs.createReadStream(uploadFile.file_path) as any,
    duplex: 'half',
  } as RequestInit);

  if (!res.ok) throw new Error(`Falló la subida a Biblioteca remota (${res.status})`);
  const data = await res.json();
  const videoId = data.video?._id ? String(data.video._id) : null;
  if (videoId) await uploadThumbnailToRemoteLibrary(authHeader, videoId, file);
  return videoId;
  } finally {
    if (normalizedPath) await fs.promises.unlink(normalizedPath).catch(() => {});
  }
}

function tusMetadata(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(',');
}

async function uploadToRemoteLibraryTus(authHeader: string, file: DbFile, sizeBytes: number): Promise<string | null> {
  const create = await fetch(`${CENTRAL}/api/remote-library/tus`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(sizeBytes),
      'Upload-Metadata': tusMetadata({
        filename: file.file_name,
        fileName: file.file_name,
        filetype: 'video/mp4',
        contentId: file.content_id,
        ...(file.duracion_segundos ? { durationSeconds: String(file.duracion_segundos) } : {}),
        ...(file.resolucion ? { resolution: file.resolucion } : {}),
        ...(file.formato ? { formato: file.formato } : {}),
      }),
    },
  });
  if (!create.ok) throw new Error(`Falló la creación de subida TUS (${create.status})`);

  let location = create.headers.get('location');
  if (!location) throw new Error('La central no devolvió la URL de subida TUS');
  if (location.startsWith('/')) location = `${CENTRAL}${location}`;

  const handle = await fs.promises.open(file.file_path, 'r');
  let uploadedId: string | null = null;
  try {
    let offset = 0;
    while (offset < sizeBytes) {
      const length = Math.min(TUS_CHUNK_SIZE, sizeBytes - offset);
      const chunk = Buffer.allocUnsafe(length);
      const read = await handle.read(chunk, 0, length, offset);
      if (read.bytesRead !== length) throw new Error('Lectura incompleta del archivo local');

      let patch: Response | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        patch = await fetch(location, {
          method: 'PATCH',
          headers: {
            Authorization: authHeader,
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
            'Content-Length': String(length),
          },
          body: chunk,
        });
        if (patch.ok) break;

        // Si el proxy o la central ya aceptó el bloque pero la respuesta se
        // perdió, recuperamos el offset real antes de reintentar.
        if (patch.status === 409) {
          const head = await fetch(location, {
            headers: { Authorization: authHeader, 'Tus-Resumable': '1.0.0' },
          });
          const serverOffset = Number(head.headers.get('upload-offset'));
          if (head.ok && Number.isFinite(serverOffset) && serverOffset >= offset && serverOffset <= sizeBytes) {
            offset = serverOffset;
            break;
          }
        }

        if (attempt < 3 && (patch.status === 408 || patch.status === 429 || patch.status >= 500)) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
          continue;
        }
        const detail = await patch.text().catch(() => '');
        throw new Error(`Falló un bloque TUS (${patch.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
      if (!patch?.ok) continue;
      const responseOffset = Number(patch.headers.get('upload-offset'));
      offset = Number.isFinite(responseOffset) ? responseOffset : offset + length;
      if (offset >= sizeBytes) {
        const payload = await patch.json().catch(() => null) as { video?: { _id?: string } } | null;
        uploadedId = payload?.video?._id ? String(payload.video._id) : null;
      }
    }
  } finally {
    await handle.close();
  }

  if (uploadedId) return uploadedId;

  const detail = await fetch(`${CENTRAL}/api/remote-library/videos/lookup?contentId=${encodeURIComponent(file.content_id)}`, {
    headers: { Authorization: authHeader },
  });
  if (!detail.ok) throw new Error(`No se pudo confirmar la subida TUS (${detail.status})`);
  const data = await detail.json();
  return data.id ? String(data.id) : null;
}

// A diferencia de subir a mano (Android/iOS/Electron generan el frame en el
// cliente y lo mandan aparte, ver uploadRemoteLibraryThumbnail en la central),
// este preload es 100% del lado del servidor local -- sin este paso el video
// quedaba en Biblioteca remota sin miniatura para siempre, mostrando el ícono
// de nube genérico en vez de un frame real en las apps. Best-effort: si falla,
// el video ya quedó subido igual, solo se pierde la miniatura.
async function uploadThumbnailToRemoteLibrary(authHeader: string, videoId: string, file: DbFile): Promise<void> {
  try {
    const { path: thumbPath } = await ensureThumbnail(file.id, file.file_path, {
      durationSec: file.duracion_segundos ?? undefined,
      hasDimensions: !!(file.formato && file.resolucion),
    });
    if (!thumbPath) return;

    const form = new FormData();
    form.append('thumbnail', new Blob([fs.readFileSync(thumbPath)], { type: 'image/jpeg' }), 'thumbnail.jpg');

    await fetch(`${CENTRAL}/api/remote-library/videos/${videoId}/thumbnail`, {
      method: 'POST',
      headers: { Authorization: authHeader },
      body: form,
    });
  } catch { /* best-effort -- ver comentario arriba */ }
}

// Se llama justo después de fijar el "próximo a publicar" de una plataforma
// (ver calendar-sync.service.ts, invocado desde youtube/instagram/tiktok-upload.controller.ts).
// Garantiza que ese video específico tenga bytes reales en Biblioteca remota
// -- si ya estaba (por content_id, no por fileName: ver
// remote-library-retention.service.ts para el porqué), no vuelve a subirlo.
// Devuelve el id real para que el caller lo mande como nextRemoteLibraryVideoId.
export async function ensureNextVideoInRemoteLibrary(
  authHeader: string | undefined,
  file: DbFile | undefined,
): Promise<string | null> {
  if (!authHeader || !file?.content_id) return null;

  const key = `${authHeader}:${file.content_id}`;
  const inFlight = inFlightByContentId.get(key);
  if (inFlight) return inFlight;

  const pending = ensureNextVideoInRemoteLibraryOnce(authHeader, file);
  inFlightByContentId.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inFlightByContentId.get(key) === pending) inFlightByContentId.delete(key);
  }
}

// Núcleo compartido por la precarga automática (best-effort, atrapa errores)
// y el push manual (deja que el error suba tal cual hasta el botón que lo
// disparó) -- mismos 3 pasos: ¿ya está en Nube?, ¿el archivo sigue en disco?,
// subir. Tira en vez de devolver null cuando algo falla, así el caller
// decide qué hacer con el mensaje real (incluido el 409 de cupo lleno de la
// central, ver remote-library-quota.service.ts).
async function resolveAndUpload(authHeader: string, file: DbFile): Promise<string | null> {
  const existing = await lookupRemoteLibraryId(authHeader, file.content_id);
  if (existing) return existing;

  if (!fs.existsSync(file.file_path)) throw new Error('El archivo ya no está en el disco.');

  setPreloadActivity({ title: file.file_name, phase: 'uploading' });
  try {
    return await uploadToRemoteLibrary(authHeader, file);
  } finally {
    clearPreloadActivity();
  }
}

async function ensureNextVideoInRemoteLibraryOnce(
  authHeader: string,
  file: DbFile,
): Promise<string | null> {
  try {
    return await resolveAndUpload(authHeader, file);
  } catch (err: any) {
    setPreloadError(file.file_name, err.message);
    return null;
  }
}

// Push manual -- dispara el botón "Subir a la nube" de un video puntual en
// Videos (ver pushVideoToCloud en video.controller.ts). A diferencia de
// ensureNextVideoInRemoteLibrary, esto NO es best-effort: el error real
// (incluido "Alcanzaste el límite de 5 videos en la nube...") tiene que
// llegar hasta el usuario que tocó el botón, no perderse en un log.
export async function pushVideoToRemoteLibrary(authHeader: string, file: DbFile): Promise<string> {
  if (!file.content_id) throw new Error('Este video no tiene un identificador válido para subir a la nube.');
  const id = await resolveAndUpload(authHeader, file);
  if (!id) throw new Error('No se pudo subir el video a la nube.');
  return id;
}
