import { Request, Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { AuthRequest } from '../middleware/auth.middleware';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import {
  resolveRemoteLibraryFilePath,
  deleteRemoteLibraryFile,
  buildRemoteLibraryTusServer,
  optimizeThumbnail,
  FinishedRemoteLibraryUpload,
} from '../services/remote-library-storage.service';

// ── Failover LAN entre los 2 backends redundantes (Mac + PC Windows, cada uno
// con su propio conector de Cloudflare Tunnel para el mismo hostname) ─────────
// Los bytes de Nube están repartidos entre las 2 máquinas (según dónde se subió
// o migró cada video) -- si la request de Cloudflare cae en la máquina que NO
// tiene ese archivo, antes tiraba 404 directo. Con PEER_BACKEND_URL configurado
// (ej. http://192.168.1.50:5001, IP fija en la LAN), se intenta 1 vez pedirle
// el archivo al otro backend directo por LAN antes de rendirse.
// - Timeout corto (no cuelga el request si la otra máquina está apagada).
// - x-internal-proxy evita que el peer vuelva a reintentar CONTRA nosotros
//   (looping) si algún día ambos lados quedan configurados simétricamente.
const PEER_BACKEND_URL = process.env.PEER_BACKEND_URL;
const PEER_PROXY_TIMEOUT_MS = 3000;

async function tryProxyFromPeer(req: AuthRequest, res: Response, path: string): Promise<boolean> {
  if (!PEER_BACKEND_URL || req.headers['x-internal-proxy']) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PEER_PROXY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'x-internal-proxy': '1' };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    if (req.headers.range) headers.range = req.headers.range as string;

    const upstream = await fetch(`${PEER_BACKEND_URL}${path}`, { headers, signal: controller.signal });
    if (!upstream.ok && upstream.status !== 206) return false;

    res.status(upstream.status);
    const relayHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const h of relayHeaders) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    if (!upstream.body) { res.end(); return true; }
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(upstream.body as any);
      stream.pipe(res);
      stream.on('error', reject);
      res.on('finish', () => resolve());
    });
    return true;
  } catch {
    // Peer caído, sin ese archivo tampoco, timeout, lo que sea -- se
    // devuelve false y el caller sigue con el 404 normal.
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Subida del video (TUS, resumable) ─────────────────────────────────────────
// Portado de server-multimedia-wyrruz (probado ahí en producción) -- reemplaza
// el multipart single-shot anterior. Necesario porque estos son videos pesados
// subidos desde el celular del cliente, no de una LAN: una conexión que se
// corta a mitad de upload antes obligaba a reintentar desde cero.
// duration/resolution/formato los sigue mandando el cliente (Android ya los
// prueba con AndroidMediaProber antes de armar el request) -- la central no
// tiene ffmpeg, no hay forma de calcularlos acá.
const remoteLibraryTusServer = buildRemoteLibraryTusServer(
  async (info: FinishedRemoteLibraryUpload) => {
    return RemoteLibraryVideoModel.create({
      userId: info.userId,
      fileName: info.fileName,
      storedFileName: info.storedFileName,
      sizeBytes: info.sizeBytes,
      durationSeconds: info.durationSeconds,
      resolution: info.resolution,
      formato: info.formato,
      platforms: [],
      platformsDiscarded: [],
    });
  },
);

// ── ALL /api/remote-library/tus(/:id) ─────────────────────────────────────────
export const handleRemoteLibraryTus = (req: Request, res: Response): void => {
  remoteLibraryTusServer.handle(req, res);
};

// ── Miniatura ──────────────────────────────────────────────────────────────
// Aparte del video: es chica (una imagen), no necesita ser resumable, así que
// se queda en multipart simple en vez de sumarle otro flujo TUS. En memoria
// (no diskStorage) porque hay que pasarla por sharp antes de guardarla --
// nunca se escribe a disco el archivo tal como lo mandó el cliente.
export const remoteLibraryThumbnailUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB de entrada -- sale mucho más chica tras optimizeThumbnail
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
}).single('thumbnail');

// ── POST /api/remote-library/videos/:id/thumbnail ─────────────────────────────
// La miniatura la genera el cliente (un frame del video) y la manda acá --
// optimizeThumbnail es la validación real: si sharp no puede decodificarla,
// no era una imagen válida sin importar lo que haya dicho el Content-Type.
export const uploadRemoteLibraryThumbnail = async (req: AuthRequest, res: Response): Promise<void> => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'No se recibió ninguna miniatura' }); return; }

  const userId = req.user!.id;
  let optimized: Buffer;
  try {
    optimized = await optimizeThumbnail(file.buffer);
  } catch {
    res.status(400).json({ error: 'La miniatura no es una imagen válida' });
    return;
  }

  const storedFileName = `${randomUUID()}.jpg`;
  try {
    const previous = await RemoteLibraryVideoModel.findOne({ _id: req.params.id, userId }).lean();
    if (!previous) { res.status(404).json({ error: 'Video no encontrado' }); return; }

    await fs.promises.writeFile(resolveRemoteLibraryFilePath(userId, storedFileName), optimized);

    const doc = await RemoteLibraryVideoModel.findOneAndUpdate(
      { _id: req.params.id, userId },
      { thumbnailStoredFileName: storedFileName },
      { new: true },
    );
    if (previous.thumbnailStoredFileName) deleteRemoteLibraryFile(userId, previous.thumbnailStoredFileName);
    res.json({ ok: true, video: doc });
  } catch (err: any) {
    deleteRemoteLibraryFile(userId, storedFileName);
    res.status(500).json({ error: 'Error al guardar la miniatura', detail: err.message });
  }
};

// ── GET /api/remote-library/videos?skip=&limit= ────────────────────────────────
// Paginado -- sin esto, una cuenta con cientos/miles de videos (ej. después de
// una migración masiva de biblioteca local a Nube) manda TODO el listado en
// una sola respuesta, cada vez que se abre la pantalla.
export const listRemoteLibraryVideos = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
    const skip = Math.max(parseInt(req.query.skip as string) || 0, 0);

    const [videos, total] = await Promise.all([
      RemoteLibraryVideoModel.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      RemoteLibraryVideoModel.countDocuments({ userId }),
    ]);
    res.json({ videos, total, hasMore: skip + videos.length < total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET /api/remote-library/videos/:id/stream ─────────────────────────────────
// Range-requests portado de local-backend/src/routes/stream.routes.ts (acá no
// existía ningún endpoint de streaming todavía).
export const streamRemoteLibraryVideo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await RemoteLibraryVideoModel.findOne({ _id: req.params.id, userId: req.user!.id }).lean();
    if (!doc) { res.status(404).json({ error: 'Video no encontrado' }); return; }

    const filePath = resolveRemoteLibraryFilePath(doc.userId, doc.storedFileName);
    if (!fs.existsSync(filePath)) {
      const path = `/api/remote-library/videos/${req.params.id}/stream`;
      if (await tryProxyFromPeer(req, res, path)) return;
      res.status(404).json({ error: 'Archivo no encontrado en disco' });
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch {
    res.status(500).json({ error: 'Error en el streaming' });
  }
};

// ── GET /api/remote-library/videos/:id/thumbnail ──────────────────────────────
export const getRemoteLibraryThumbnail = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await RemoteLibraryVideoModel.findOne({ _id: req.params.id, userId: req.user!.id }).lean();
    if (!doc?.thumbnailStoredFileName) { res.status(404).json({ error: 'Sin miniatura' }); return; }

    const filePath = resolveRemoteLibraryFilePath(doc.userId, doc.thumbnailStoredFileName);
    if (!fs.existsSync(filePath)) {
      const path = `/api/remote-library/videos/${req.params.id}/thumbnail`;
      if (await tryProxyFromPeer(req, res, path)) return;
      res.status(404).json({ error: 'Miniatura no encontrada en disco' });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// ── PATCH /api/remote-library/videos/:id ──────────────────────────────────────
// La central lleva el estado de "qué ya se publicó" de esta cola porque
// Android publica DIRECTO a YouTube/Meta/TikTok (nunca pasa por acá) -- este
// endpoint es lo único que deja ese resultado asentado del lado central.
export const updateRemoteLibraryVideoPlatforms = async (req: AuthRequest, res: Response): Promise<void> => {
  const { platforms, platformsDiscarded } = req.body;
  try {
    const doc = await RemoteLibraryVideoModel.findOneAndUpdate(
      { _id: req.params.id, userId: req.user!.id },
      {
        ...(platforms !== undefined ? { platforms } : {}),
        ...(platformsDiscarded !== undefined ? { platformsDiscarded } : {}),
      },
      { new: true },
    );
    if (!doc) { res.status(404).json({ error: 'Video no encontrado' }); return; }
    res.json({ ok: true, video: doc });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// ── DELETE /api/remote-library/videos/:id ─────────────────────────────────────
export const deleteRemoteLibraryVideo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await RemoteLibraryVideoModel.findOneAndDelete({ _id: req.params.id, userId: req.user!.id });
    if (!doc) { res.status(404).json({ error: 'Video no encontrado' }); return; }

    deleteRemoteLibraryFile(doc.userId, doc.storedFileName);
    if (doc.thumbnailStoredFileName) deleteRemoteLibraryFile(doc.userId, doc.thumbnailStoredFileName);

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
