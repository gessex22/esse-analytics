import { Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth.middleware';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';

// Storage persistente (NO os.tmpdir() — a diferencia de remoteUploadMiddleware
// en youtube-upload.controller.ts, que es efímero y borra apenas termina de
// publicar). CENTRAL_REMOTE_LIBRARY_DIR es opcional, con default sensato si
// no está seteada.
function getRemoteLibraryDir(): string {
  const dir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Un solo request multipart con dos campos (video + thumbnail opcional) --
// mismo patrón de límite/filtro que remoteUploadMiddleware, pero con
// destination fijo al directorio persistente y filename propio (uuid +
// extensión real, evita colisiones y mantiene el storedFileName legible).
export const remoteLibraryUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, getRemoteLibraryDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || (file.fieldname === 'thumbnail' ? '.jpg' : '.mp4');
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB, mismo límite que remoteUploadMiddleware
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'video') { cb(null, file.mimetype.startsWith('video/')); return; }
    if (file.fieldname === 'thumbnail') { cb(null, file.mimetype.startsWith('image/')); return; }
    cb(null, false);
  },
}).fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]);

// ── POST /api/remote-library/videos ───────────────────────────────────────────
// duration/resolution/formato los manda el cliente (Android ya los prueba con
// AndroidMediaProber antes de armar el request) -- la central no tiene ffmpeg
// tampoco, no hay forma de calcularlos acá.
export const uploadRemoteLibraryVideo = async (req: AuthRequest, res: Response): Promise<void> => {
  const files = req.files as { video?: Express.Multer.File[]; thumbnail?: Express.Multer.File[] } | undefined;
  const video = files?.video?.[0];
  const thumbnail = files?.thumbnail?.[0];

  if (!video) {
    if (thumbnail) fs.unlink(thumbnail.path, () => {});
    res.status(400).json({ error: 'No se recibió ningún archivo de video' });
    return;
  }

  const { fileName, durationSeconds, resolution, formato } = req.body;

  try {
    const doc = await RemoteLibraryVideoModel.create({
      userId: req.user!.id,
      fileName: fileName || video.originalname,
      storedFileName: video.filename,
      sizeBytes: video.size,
      durationSeconds: durationSeconds ? Number(durationSeconds) : undefined,
      resolution: resolution || undefined,
      formato: formato || undefined,
      thumbnailStoredFileName: thumbnail?.filename,
      platforms: [],
      platformsDiscarded: [],
    });
    res.json({ ok: true, video: doc });
  } catch (err: any) {
    fs.unlink(video.path, () => {});
    if (thumbnail) fs.unlink(thumbnail.path, () => {});
    res.status(500).json({ error: 'Error al guardar el video', detail: err.message });
  }
};

// ── GET /api/remote-library/videos ────────────────────────────────────────────
export const listRemoteLibraryVideos = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const videos = await RemoteLibraryVideoModel.find({ userId: req.user!.id }).sort({ createdAt: -1 }).lean();
    res.json({ videos });
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

    const filePath = path.join(getRemoteLibraryDir(), doc.storedFileName);
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'Archivo no encontrado en disco' }); return; }

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

    const filePath = path.join(getRemoteLibraryDir(), doc.thumbnailStoredFileName);
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'Miniatura no encontrada en disco' }); return; }

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

    const dir = getRemoteLibraryDir();
    fs.unlink(path.join(dir, doc.storedFileName), () => {});
    if (doc.thumbnailStoredFileName) fs.unlink(path.join(dir, doc.thumbnailStoredFileName), () => {});

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
