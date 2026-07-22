import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { Server, EVENTS } from '@tus/server';
import { FileStore } from '@tus/file-store';
import sharp from 'sharp';
import { decodeAuthToken } from '../middleware/auth.middleware';

// Único punto de la app que sabe DÓNDE y CÓMO se guardan los bytes de la
// Biblioteca remota (disco local de la central, vía TUS resumable). Si más
// adelante esto se muda a un servicio de multimedia aparte (ver
// server-multimedia-wyrruz), solo este archivo cambia -- el controller y las
// rutas siguen hablando en términos de storedFileName, nunca de fs/path.

export function getRemoteLibraryDir(): string {
  const dir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRemoteLibraryTusTempDir(): string {
  const dir = path.join(getRemoteLibraryDir(), '.tmp_tus');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Un subdirectorio por usuario (no todo en un solo directorio plano) -- esto
// es lo que va a importar el día que esto sea multi-tenant real: permite
// recorrer/borrar/medir el storage de UN cliente sin tener que filtrar por
// Mongo, y evita que un storedFileName de otro usuario sea "adivinable" en
// el mismo namespace. `userId` sale siempre del JWT server-side, nunca del
// cliente -- ver onUploadCreate más abajo.
function getUserDir(userId: string): string {
  const dir = path.join(getRemoteLibraryDir(), userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveRemoteLibraryFilePath(userId: string, storedFileName: string): string {
  return path.join(getUserDir(userId), storedFileName);
}

export function deleteRemoteLibraryFile(userId: string, storedFileName: string): void {
  fs.unlink(resolveRemoteLibraryFilePath(userId, storedFileName), () => {});
}

export interface FinishedRemoteLibraryUpload {
  userId: string;
  storedFileName: string;
  sizeBytes: number;
  fileName: string;
  durationSeconds?: number;
  resolution?: string;
  formato?: string;
  contentId?: string;
}

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB, mismo límite que la subida single-shot anterior

// Whitelist en vez de "lo que sea que el cliente diga que es" -- el filetype/
// filename de Upload-Metadata los arma el cliente, no está verificado contra
// los bytes reales. Si no matchea nada conocido cae a .mp4 (mismo default de
// siempre) en vez de guardar una extensión arbitraria en disco.
const VIDEO_EXT_WHITELIST = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp']);

function extFromMetadata(meta: Record<string, string | null> | undefined): string {
  const name = meta?.filename;
  const ext = name ? path.extname(name).toLowerCase() : '';
  return VIDEO_EXT_WHITELIST.has(ext) ? ext : '.mp4';
}

// Nombre para MOSTRAR (título en la lista, no el nombre en disco -- ese
// siempre es un uuid). Normaliza separadores de path y le pone un tope de
// largo -- esto es lo que se ve en LibraryPanel/listados, no puede venir
// crudo del cliente.
const BACKSLASH = String.fromCharCode(92);
const BAD_NAME_CHARS = new Set([BACKSLASH, '/', ':', '*', '?', String.fromCharCode(34), '<', '>', '|']); // separadores de path, no validos en un titulo mostrado
export function sanitizeDisplayName(name: string | null | undefined, fallback: string): string {
  const base = (name || '').normalize('NFC');
  let out = '';
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    out += (code < 32 || BAD_NAME_CHARS.has(ch)) ? ' ' : ch;
  }
  const cleaned = out.replace(/ {2,}/g, ' ').trim();
  return (cleaned || fallback).slice(0, 200);
}

// Tope generoso de dimensiones -- el frame que manda el cliente ya viene
// recortado a un frame de video, esto es sobre todo para el caso patológico
// (una foto de cámara de 12000x9000 mandada por error como "miniatura").
const THUMBNAIL_MAX_DIMENSION = 1280;
const THUMBNAIL_JPEG_QUALITY = 80;

// Server-side, no confiamos en "es una imagen" solo porque el mimetype del
// multipart lo diga (eso lo arma el cliente). sharp() falla si los bytes no
// son una imagen decodificable -- esa excepción ES la validación. Reencodear
// a JPEG con un tope de tamaño de paso resuelve "optimizada en peso" a la vez:
// no queremos que el celular mande el frame a resolución original del video.
export async function optimizeThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .rotate() // aplica la orientación EXIF y la descarta (evita miniaturas giradas)
    .resize({
      width: THUMBNAIL_MAX_DIMENSION,
      height: THUMBNAIL_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMBNAIL_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

// `onFinished` es donde el controller mete la lógica de negocio (crear el
// documento en Mongo) -- este módulo no importa el modelo, solo mecánica de
// storage. Se invoca DESDE onUploadFinish (antes de responder al cliente),
// para poder devolver el documento creado en el body de la respuesta final
// de TUS. El archivo físico recién se mueve en POST_FINISH (después de
// responder) -- moverlo antes deja el archivo bloqueado/abierto y el PATCH
// final de TUS responde 500 (visto en server-multimedia-wyrruz).
export function buildRemoteLibraryTusServer(
  onFinished: (info: FinishedRemoteLibraryUpload) => Promise<unknown>,
): Server {
  const tempDir = getRemoteLibraryTusTempDir();
  const datastore = new FileStore({ directory: tempDir });

  // @tus/server maneja su propio CORS (independiente del cors() de Express en
  // server.ts) -- sin esto responde Access-Control-Allow-Origin: * en vez de
  // respetar ALLOWED_ORIGINS como el resto de la API.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
    'https://esse-analytics.com,https://www.esse-analytics.com')
    .split(',').map(s => s.trim()).filter(Boolean);

  // El Location que arma @tus/server por default sale de req.headers.host --
  // detrás del túnel de Cloudflare eso es 'localhost:5001' (el host interno,
  // no el público), así que el cliente terminaba mandando los PATCH de los
  // fragmentos siguientes a una URL inalcanzable desde afuera de la Mac.
  // Fijamos el origin público explícito en vez de depender de que Cloudflare
  // reenvíe X-Forwarded-Host/Proto (respectForwardedHeaders) correctamente.
  const publicOrigin = process.env.PUBLIC_API_ORIGIN || 'https://api.esse-analytics.com';

  const tusServer = new Server({
    path: '/api/remote-library/tus',
    datastore,
    maxSize: MAX_UPLOAD_SIZE,
    allowedOrigins,
    generateUrl: (_req, { path, id }) => `${publicOrigin}${path}/${id}`,

    // Se re-verifica el JWT acá en vez de confiar en algo puesto por el
    // middleware de Express: @tus/server envuelve el request original en su
    // propia abstracción (srvx) antes de llamar a estos hooks, así que
    // cualquier propiedad custom (`req.user`) no está garantizado que
    // sobreviva ese wrapping. `req.headers` (Fetch API estándar) sí.
    onUploadCreate: async (req, upload) => {
      const auth = req.headers.get('authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
      const user = token ? decodeAuthToken(token) : null;
      if (!user) throw new Error('Token requerido o inválido.');

      const storedFileName = `${randomUUID()}${extFromMetadata(upload.metadata ?? undefined)}`;
      return {
        metadata: { ...(upload.metadata ?? {}), userId: user.id, storedFileName },
      };
    },

    // Antes de responder: ya tenemos todos los bytes (offset === size) pero
    // el archivo todavía puede estar abierto -- solo tocamos Mongo acá, nada
    // de fs. Devolvemos el doc creado en el body (tolerado por la mayoría de
    // los clientes TUS aunque el spec solo pida 204).
    onUploadFinish: async (_req, upload) => {
      const meta = upload.metadata ?? {};
      const storedFileName = meta.storedFileName;
      const userId = meta.userId;
      if (!storedFileName || !userId) throw new Error('Metadata de subida incompleta.');

      const doc = await onFinished({
        userId,
        storedFileName,
        sizeBytes: upload.size ?? 0,
        fileName: sanitizeDisplayName(meta.fileName || meta.filename, storedFileName),
        durationSeconds: meta.durationSeconds ? Number(meta.durationSeconds) : undefined,
        resolution: meta.resolution || undefined,
        formato: meta.formato || undefined,
        contentId: meta.contentId || undefined,
      });

      // 204 (el default de PATCH) es un "null body status" para la Response
      // subyacente -- cualquier body que se le ponga se descarta en silencio.
      // Forzamos 200 para que el doc creado sí llegue al cliente.
      return { status_code: 200, body: JSON.stringify({ ok: true, video: doc }) };
    },
  });

  tusServer.on(EVENTS.POST_FINISH, async (_req, _res, upload) => {
    const storedFileName = upload.metadata?.storedFileName;
    const userId = upload.metadata?.userId;
    if (!storedFileName || !userId) return;

    try {
      const tmpPath = path.join(tempDir, upload.id);
      await fs.promises.rename(tmpPath, resolveRemoteLibraryFilePath(userId, storedFileName));
    } catch (err) {
      console.error('[remote-library] Error moviendo archivo subido por TUS:', err);
    }

    // Limpieza del registro interno de TUS (el archivo ya no vive en tempDir,
    // así que datastore.remove() fallaría al intentar borrarlo de nuevo).
    try {
      await (datastore as FileStore).configstore.delete(upload.id);
    } catch { /* best effort */ }
  });

  return tusServer;
}
