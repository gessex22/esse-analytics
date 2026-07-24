import fs from 'fs';
import { DbFile } from '../db/file.repo';
import { setPreloadActivity, clearPreloadActivity, setPreloadError } from '../state/remote-library-preload-activity';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

async function lookupRemoteLibraryId(authHeader: string, contentId: string): Promise<string | null> {
  const res = await fetch(`${CENTRAL}/api/remote-library/videos/lookup?contentId=${encodeURIComponent(contentId)}`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.id ?? null;
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
  return data.video?._id ? String(data.video._id) : null;
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
