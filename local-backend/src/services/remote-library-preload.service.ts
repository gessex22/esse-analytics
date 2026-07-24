import fs from 'fs';
import { DbFile } from '../db/file.repo';
import { setPreloadActivity, clearPreloadActivity, setPreloadError } from '../state/remote-library-preload-activity';
import { ensureThumbnail } from './thumbnail.service';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

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
  return detailData.video?.storedFileName ? String(data.id) : null;
}

async function uploadToRemoteLibrary(authHeader: string, file: DbFile): Promise<string | null> {
  const params = new URLSearchParams({ fileName: file.file_name, contentId: file.content_id ?? '' });
  if (file.duracion_segundos) params.set('durationSeconds', String(file.duracion_segundos));
  if (file.resolucion) params.set('resolution', file.resolucion);
  if (file.formato) params.set('formato', file.formato);

  const stat = fs.statSync(file.file_path);
  const res = await fetch(`${CENTRAL}/api/remote-library/videos/import?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size) },
    body: fs.createReadStream(file.file_path) as any,
    duplex: 'half',
  } as RequestInit);

  if (!res.ok) throw new Error(`Falló la subida a Biblioteca remota (${res.status})`);
  const data = await res.json();
  const videoId = data.video?._id ? String(data.video._id) : null;
  if (videoId) await uploadThumbnailToRemoteLibrary(authHeader, videoId, file);
  return videoId;
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

async function ensureNextVideoInRemoteLibraryOnce(
  authHeader: string,
  file: DbFile,
): Promise<string | null> {

  try {
    const existing = await lookupRemoteLibraryId(authHeader, file.content_id);
    if (existing) return existing;

    if (!fs.existsSync(file.file_path)) return null; // el archivo ya no está en disco -- nada que subir

    setPreloadActivity({ title: file.file_name, phase: 'uploading' });
    const id = await uploadToRemoteLibrary(authHeader, file);
    clearPreloadActivity();
    return id;
  } catch (err: any) {
    setPreloadError(file.file_name, err.message);
    return null;
  }
}
