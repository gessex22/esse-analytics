import { Request, Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { AuthRequest } from '../middleware/auth.middleware';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { applyPlatformPublish } from './backup.controller';
import {
  resolveRemoteLibraryFilePath,
  deleteRemoteLibraryFile,
  buildRemoteLibraryTusServer,
  optimizeThumbnail,
  extFromFileName,
  sanitizeDisplayName,
  MAX_UPLOAD_SIZE,
  FinishedRemoteLibraryUpload,
} from '../services/remote-library-storage.service';
import { ensureRemoteLibraryCapacity } from '../services/remote-library-quota.service';

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
    // TUS puede reintentarse después de un corte o un 409 de offset. Upsert
    // por la identidad estable del archivo evita crear un documento Mongo por
    // cada intento y conserva links/estados ya asociados al video.
    if (info.contentId) {
      const previous = await RemoteLibraryVideoModel.findOne({
        userId: info.userId,
        contentId: info.contentId,
      }).select('storedFileName').lean();
      const doc = await RemoteLibraryVideoModel.findOneAndUpdate(
        { userId: info.userId, contentId: info.contentId },
        {
          $set: {
            fileName: info.fileName,
            storedFileName: info.storedFileName,
            sizeBytes: info.sizeBytes,
            durationSeconds: info.durationSeconds,
            resolution: info.resolution,
            formato: info.formato,
            safeToEvict: true,
          },
          $setOnInsert: {
            userId: info.userId,
            contentId: info.contentId,
            platforms: [],
            platformsDiscarded: [],
          },
        },
        { upsert: true, new: true },
      );
      if (previous?.storedFileName && previous.storedFileName !== info.storedFileName) {
        deleteRemoteLibraryFile(info.userId, previous.storedFileName);
      }
      return doc;
    }

    // Sin contentId: no hay forma de cruzar esto con un archivo conocido en
    // la biblioteca local (típico de una subida directa desde el celular sin
    // que ese video haya existido nunca en la PC) -- safeToEvict queda en el
    // default (false, ver el schema): estos bytes SON la única copia real,
    // el barrido de retención no debe tocarlos jamás. Antes acá se mandaba
    // safeToEvict: true por error, así que estas subidas se liberaban solas
    // en el próximo barrido apenas dejaban de ser "el próximo a publicar" --
    // pérdida de datos real y silenciosa para justo el caso que este flag
    // existe para proteger (ver remote-library-video.model.ts).
    return RemoteLibraryVideoModel.create({
      userId: info.userId,
      contentId: info.contentId,
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
  (userId, contentId) => ensureRemoteLibraryCapacity(userId, contentId),
);

// ── ALL /api/remote-library/tus(/:id) ─────────────────────────────────────────
export const handleRemoteLibraryTus = (req: Request, res: Response): void => {
  remoteLibraryTusServer.handle(req, res);
};

// ── GET /api/remote-library/videos/lookup?contentId= ──────────────────────────
// El cliente (local-backend, ver calendar-sync.service.ts) usa esto para saber
// si "el próximo video a publicar" YA está en Biblioteca remota antes de
// subirlo de nuevo -- por contentId (files.content_id local), no por fileName:
// un nombre de archivo puede repetirse dentro de la misma cuenta (ver
// remote-library-retention.service.ts), contentId no.
export const lookupRemoteLibraryVideoByContentId = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const contentId = req.query.contentId as string | undefined;
    if (!contentId) { res.status(400).json({ error: 'contentId requerido' }); return; }

    // Solo cuenta como "ya precargado" si TODAVÍA tiene bytes reales -- un doc
    // sin storedFileName (barrido de retención lo liberó porque dejó de ser
    // "el próximo", o nunca tuvo bytes, solo metadata de catálogo) no sirve
    // para publicar: sin este chequeo, el precargado se daba por hecho y
    // nunca volvía a subir el archivo (bug real confirmado en producción).
    // Puede haber filas antiguas de catálogo sin bytes y otra fila posterior
    // con la precarga real. Filtrar en Mongo evita que findOne() elija primero
    // la fila huérfana y devuelva un falso positivo.
    const doc = await RemoteLibraryVideoModel.findOne({
      userId: req.user!.id,
      contentId,
      storedFileName: { $exists: true, $nin: [null, ''] },
    }).sort({ updatedAt: -1, _id: -1 }).select('_id storedFileName').lean();
    res.json({ id: doc?.storedFileName ? String(doc._id) : null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// ── POST /api/remote-library/videos/import?fileName=&contentId=&durationSeconds=&resolution=&formato= ──
// Relay server-a-servidor: local-backend sube acá directo (sin pasar por el
// cliente/renderer) el archivo de "próximo a publicar" que todavía no estaba
// en Biblioteca remota, para que el almacenamiento dinámico (ver
// remote-library-retention.service.ts) tenga algo que proteger. Body = bytes
// crudos del video (Content-Type video/* u octet-stream) -- no multipart, no
// TUS: es un solo tiro confiable en LAN/localhost, no una subida resumable
// desde una conexión de celular que se puede cortar.
export const importRemoteLibraryVideo = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const contentLength = parseInt(req.headers['content-length'] as string, 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_SIZE) {
    res.status(413).json({ error: 'Archivo demasiado grande' });
    return;
  }

  const contentId = (req.query.contentId as string) || undefined;

  // Este endpoint solo lo llama ensureNextVideoInRemoteLibrary (local-backend)
  // para precargar el "próximo a publicar" de una red -- si el cupo está lleno,
  // intenta liberar el más viejo no protegido/evictable antes de rechazar (ver
  // remote-library-quota.service.ts). Si no hay nada para liberar (los 5
  // lugares son copias únicas subidas a mano), la precarga de ESTA red
  // simplemente no se completa -- el caller (ensurePreloadForNextVideos) ya
  // trata cualquier falla acá como best-effort, loguea y sigue con las demás.
  const hasRoom = await ensureRemoteLibraryCapacity(userId, contentId);
  if (!hasRoom) {
    res.status(409).json({ error: 'Alcanzaste el límite de 5 videos en la nube.' });
    return;
  }

  const fileName = sanitizeDisplayName(req.query.fileName as string, 'video.mp4');
  const durationSeconds = req.query.durationSeconds ? Number(req.query.durationSeconds) : undefined;
  const resolution = (req.query.resolution as string) || undefined;
  const formato = (req.query.formato as string) || undefined;

  const storedFileName = `${randomUUID()}${extFromFileName(req.query.fileName as string)}`;
  const filePath = resolveRemoteLibraryFilePath(userId, storedFileName);
  const writeStream = fs.createWriteStream(filePath);

  req.pipe(writeStream);

  writeStream.on('error', (err) => {
    fs.unlink(filePath, () => {});
    if (!res.headersSent) res.status(500).json({ error: 'Error al guardar el archivo', detail: err.message });
  });
  req.on('error', () => writeStream.destroy());

  writeStream.on('finish', async () => {
    try {
      const sizeBytes = fs.statSync(filePath).size;
      // Upsert por contentId, no create() ciego -- si ya existía un doc para
      // este video (metadata de catálogo sin bytes, o bytes liberados por el
      // barrido de retención), hay que reusarlo: crear uno nuevo dejaría dos
      // filas de Nube para el mismo video, una con badges/platformLinks y otra
      // con los bytes recién subidos, divergiendo entre sí.
      const previous = contentId
        ? await RemoteLibraryVideoModel.findOne({ userId, contentId }).select('storedFileName').lean()
        : null;
      const doc = contentId
        ? await RemoteLibraryVideoModel.findOneAndUpdate(
            { userId, contentId },
            {
              $set: { fileName, storedFileName, sizeBytes, durationSeconds, resolution, formato, safeToEvict: true },
              $setOnInsert: { userId, contentId, platforms: [], platformsDiscarded: [] },
            },
            { upsert: true, new: true },
          )
        : await RemoteLibraryVideoModel.create({
            userId, contentId, fileName, storedFileName, sizeBytes,
            durationSeconds, resolution, formato,
            platforms: [], platformsDiscarded: [],
            // Este endpoint solo lo llama local-backend (ensureNextVideoInRemoteLibrary)
            // para un archivo que YA confirmó que existe en la biblioteca local --
            // no es la única copia, el sweep puede liberarlo más adelante sin miedo.
            safeToEvict: true,
          });
      if (previous?.storedFileName && previous.storedFileName !== doc.storedFileName) {
        deleteRemoteLibraryFile(userId, previous.storedFileName);
      }
      res.json({ ok: true, video: doc });
    } catch (err: any) {
      fs.unlink(filePath, () => {});
      res.status(500).json({ error: 'Error al registrar el video', detail: err.message });
    }
  });
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

// ── GET /api/remote-library/videos?skip=&limit=&sort=&pendingOnly= ───────────
// Paginado -- sin esto, una cuenta con cientos/miles de videos (ej. después de
// una migración masiva de biblioteca local a Nube) manda TODO el listado en
// una sola respuesta, cada vez que se abre la pantalla.
// sort=asc + pendingOnly=true + limit=1 es lo que usa el iPhone para resolver
// "el siguiente video de la cola" cuando no queda nada pendiente en local --
// el más viejo (createdAt ascendente) que todavía no está resuelto en las 3
// plataformas, mismo criterio que resolveNextForPlatform en el desktop.
export const listRemoteLibraryVideos = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
    const skip = Math.max(parseInt(req.query.skip as string) || 0, 0);
    const sortOrder: 1 | -1 = req.query.sort === 'asc' ? 1 : -1;
    const pendingOnly = req.query.pendingOnly === 'true';

    const filter: Record<string, unknown> = { userId };
    if (pendingOnly) {
      filter.$expr = {
        $lt: [
          {
            $add: [
              { $size: { $ifNull: ['$platforms', []] } },
              { $size: { $ifNull: ['$platformsDiscarded', []] } },
            ],
          },
          3,
        ],
      };
    } else {
      // Listado normal (vista de escritorio) -- oculta lo que el almacenamiento
      // dinámico ya liberó (storedFileName null, ver remote-library-retention.service.ts):
      // mostrar la tarjeta de un video sin bytes reales confundía más de lo que
      // ayudaba. No se aplica bajo pendingOnly porque eso resuelve "próximo en
      // cola" para el celular por otro criterio (más viejo sin resolver) --
      // filtrar ahí podría saltear un video que el celular sí necesita ver.
      filter.storedFileName = { $ne: null };
    }

    const [videos, total] = await Promise.all([
      RemoteLibraryVideoModel.find(filter).sort({ createdAt: sortOrder }).skip(skip).limit(limit).lean(),
      RemoteLibraryVideoModel.countDocuments(filter),
    ]);
    res.json({ videos, total, hasMore: skip + videos.length < total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// ── GET /api/remote-library/videos/:id ────────────────────────────────────────
// Un solo video -- lo usa el cliente para refrescar platforms/platformsDiscarded
// de un archivo YA descargado antes de publicar (ver PublishFormView en iOS):
// un archivo bajado antes de que la nube tuviera el dato correcto quedaba con
// el estado viejo para siempre si nadie lo volvía a pedir.
export const getRemoteLibraryVideo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await RemoteLibraryVideoModel.findOne({ _id: req.params.id, userId: req.user!.id }).lean();
    if (!doc) { res.status(404).json({ error: 'Video no encontrado' }); return; }
    res.json({ ok: true, video: doc });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// fs.existsSync dio un "no encontrado" puntual para un archivo que estaba ahí
// -- reproducido en vivo (curl inmediatamente después: 200 OK) -- lo más
// probable es contención de corto plazo en el filesystem de Windows (ej. el
// antivirus escaneando el archivo en ese instante exacto). Un solo reintento
// tras una pausa chica absorbe ese hipo sin esconder un 404 real (el archivo
// sigue sin estar ahí en los reintentos si de verdad no existe).
async function existsWithRetry(filePath: string, retries = 2, delayMs = 150): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (fs.existsSync(filePath)) return true;
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// ── GET /api/remote-library/videos/:id/stream ─────────────────────────────────
// Range-requests portado de local-backend/src/routes/stream.routes.ts (acá no
// existía ningún endpoint de streaming todavía).
export const streamRemoteLibraryVideo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await RemoteLibraryVideoModel.findOne({ _id: req.params.id, userId: req.user!.id }).lean();
    if (!doc) { res.status(404).json({ error: 'Video no encontrado' }); return; }
    // Almacenamiento dinámico ya liberó los bytes (ver remote-library-retention.service.ts)
    // -- el doc/miniatura siguen, pero no hay nada que streamear ni en el peer
    // (storedFileName es un campo de Mongo, compartido por los 2 backends).
    if (!doc.storedFileName) { res.status(404).json({ error: 'Video liberado de Biblioteca remota' }); return; }

    const filePath = resolveRemoteLibraryFilePath(doc.userId, doc.storedFileName);
    if (!(await existsWithRetry(filePath))) {
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
      // "bytes=-N" (sufijo, RFC 7233 §2.1: "los últimos N bytes") -- startStr
      // queda vacío porque el string arranca con "-". ExoPlayer lo manda para
      // ubicar el moov atom en videos grabados con el celular (queda al final
      // del archivo, no al principio como en un mp4 "fast-start"). Antes esto
      // parseaba start como NaN -> Content-Range inválido -> streaming roto
      // (502 en el borde) para CUALQUIER video que necesitara este pedido
      // específico para poder empezar a reproducirse.
      const isSuffixRange = startStr === '' && endStr !== undefined;
      const start = isSuffixRange ? Math.max(0, fileSize - parseInt(endStr, 10)) : parseInt(startStr, 10);
      const end = isSuffixRange ? fileSize - 1 : (endStr ? parseInt(endStr, 10) : fileSize - 1);
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
    if (!(await existsWithRetry(filePath))) {
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
// Android/iOS publican DIRECTO a YouTube/Meta/TikTok (nunca pasa por acá) --
// este endpoint es lo único que deja ese resultado asentado del lado central.
export const updateRemoteLibraryVideoPlatforms = async (req: AuthRequest, res: Response): Promise<void> => {
  const { platforms, platformsDiscarded, platformLinks } = req.body;
  try {
    const userId = req.user!.id;
    // Se necesita el estado ANTES del update para dos cosas: el merge de
    // platformLinks (ya existía) y ahora también para saber qué plataformas
    // son una novedad real (ver el best-effort de abajo).
    const before = await RemoteLibraryVideoModel.findOne(
      { _id: req.params.id, userId },
      { platforms: 1, platformLinks: 1, fileName: 1, contentId: 1 },
    ).lean();
    if (!before) { res.status(404).json({ error: 'Video no encontrado' }); return; }

    const update: Record<string, unknown> = {};
    if (platforms !== undefined) update.platforms = platforms;
    if (platformsDiscarded !== undefined) update.platformsDiscarded = platformsDiscarded;

    // Merge por plataforma (reemplaza el link de ESA plataforma si ya
    // existía, deja los demás intactos) -- nunca un reemplazo ciego del
    // array entero, o publicar en una plataforma pisaría el link que ya
    // había quedado registrado para otra.
    if (Array.isArray(platformLinks) && platformLinks.length > 0) {
      const incomingPlatforms = new Set(platformLinks.map((l: any) => l.platform));
      const kept = (before.platformLinks ?? []).filter((l: any) => !incomingPlatforms.has(l.platform));
      update.platformLinks = [...kept, ...platformLinks];
    }

    const doc = await RemoteLibraryVideoModel.findOneAndUpdate(
      { _id: req.params.id, userId },
      update,
      { new: true },
    );
    if (!doc) { res.status(404).json({ error: 'Video no encontrado' }); return; }
    res.json({ ok: true, video: doc });

    // Best-effort, después de responder: marcar publicado desde Nube antes
    // solo tocaba este documento -- si vino con un link real (platformLinks,
    // no solo el toggle de badge) para una plataforma que ANTES no estaba
    // marcada acá, también puede ser la fuente de verdad para el archivo
    // local del mismo video (por fileName/contentId). Sin esto, el badge y el
    // link quedaban invisibles en Videos/Sincronizar/Calendario.
    if (Array.isArray(platformLinks)) {
      for (const link of platformLinks) {
        if (!link?.platform || !link?.platformId) continue;
        if ((before.platforms ?? []).includes(link.platform)) continue; // ya estaba, no es novedad
        applyPlatformPublish(userId, {
          platform: link.platform, platformId: link.platformId, platformUrl: link.platformUrl,
          fileName: before.fileName, contentId: before.contentId,
          publishedAt: link.publishedAt ? new Date(link.publishedAt) : undefined,
        }).catch((err: any) => console.warn('[updateRemoteLibraryVideoPlatforms] applyPlatformPublish falló:', err.message));
      }
    }
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
