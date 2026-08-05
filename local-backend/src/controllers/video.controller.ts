import { Request, Response } from 'express';
import { fileRepo, FileContentStatus, Platform } from '../db/file.repo';
import { configRepo } from '../db/config.repo';
import { transcriptRepo } from '../db/transcript.repo';
import { publishingStatusRepo } from '../db/publishing-status.repo';
import { platformVideoRepo } from '../db/platform-video.repo';
import { pushFilesToCloudInBackground } from './backup-sync.controller';
import { reportUploadEvent, reportUnlinkPlatform } from '../services/upload-history.service';
import { syncNextVideoToCentral } from '../services/calendar-sync.service';
import { ensureThumbnail, deleteThumbnail, probeVideoInfo } from '../services/thumbnail.service';
import { pushVideoToRemoteLibrary } from '../services/remote-library-preload.service';
import fs from 'fs';
import path from 'path';

// ── GET /api/videos ───────────────────────────────────────────────────────────
export const getVideos = (req: Request, res: Response) => {
  const page   = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit  = Math.max(1, parseInt(req.query.limit as string) || 10);
  const offset = (page - 1) * limit;
  const { search, status, content_status, tipo, order } = req.query;

  const { rows, total } = fileRepo.findAll({
    search:         search as string | undefined,
    status:         status as string | undefined,
    // Sin status explícito → oculta los borrados del disco (huérfanos de un rename, etc.)
    excludeStatus:  status ? undefined : 'ELIMINADO_DISCO',
    // Sin filtro explícito del frontend → oculta por defecto los completos en las 3 plataformas
    content_status: (content_status as string | undefined) || 'no_completo',
    tipo:           tipo as string | undefined,
    order:          (order === 'asc' ? 'asc' : 'desc'),
    limit,
    offset,
  });

  // La publicación real también queda registrada en platform_videos. Si por
  // una sincronización incompleta llegó el link pero no el array platforms,
  // el link es la evidencia más fuerte: reparamos el badge antes de responder
  // y lo dejamos persistido para que el siguiente push lo lleve a la nube.
  let repairedFromLinks = false;
  const publishable: Platform[] = ['youtube', 'instagram', 'tiktok'];
  for (const file of rows) {
    for (const platform of publishable) {
      const platformVideo = platformVideoRepo.findByFileAndPlatform(file.id, platform);
      // platform_id identifica una publicación aunque la plataforma no haya
      // devuelto permalink (caso frecuente en TikTok o publicación manual).
      // El URL se mantiene vacío y la UI puede mostrar "Sin link".
      if (platformVideo?.platform_id && !file.platforms.includes(platform)) {
        fileRepo.addPlatform(file.id, platform);
        file.platforms = [...file.platforms, platform];
        file.platforms_discarded = file.platforms_discarded.filter(p => p !== platform);
        repairedFromLinks = true;
      }
    }
  }
  if (repairedFromLinks) pushFilesToCloudInBackground(req.headers.authorization);

  const totalPages = Math.ceil(total / limit);

  res.json({
    info: {
      totalRecords: total,
      totalPages,
      currentPage:  page,
      nextPage:     page < totalPages ? page + 1 : null,
      prevPage:     page > 1 ? page - 1 : null,
    },
    results: rows.map(f => ({
      _id: String(f.id),
      file_id: {
        _id: String(f.id),
        content_id: f.content_id,
        file_name: f.file_name,
        file_path: f.file_path,
        status: f.status,
        content_status: f.content_status,
        duracion_segundos: f.duracion_segundos,
        resolucion: f.resolucion,
        formato: f.formato,
        fecha_creacion: f.fecha_creacion ?? f.created_at,
      },
      platforms: f.platforms,
      platforms_discarded: f.platforms_discarded,
      tipo_contenido: f.tipo_contenido ?? null,
      duracion_segundos: f.duracion_segundos,
      resolucion: f.resolucion,
      formato: f.formato,
      fecha_creacion: f.fecha_creacion ?? f.created_at,
    })),
  });
};

// ── GET /api/videos/slim ──────────────────────────────────────────────────────
export const getVideoSlimList = (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 1200, 2000);
  const files = fileRepo.findSlim(limit);
  res.json(files.map(f => ({
    fileId:    String(f.id),
    title:     f.file_name,
    filePath:  f.file_path,
    duration:  f.duracion_segundos ? formatDuration(f.duracion_segundos) : '',
    platforms: [...new Set([
      ...f.platforms,
      ...(['youtube', 'instagram', 'tiktok'] as Platform[]).filter(platform =>
        !!platformVideoRepo.findByFileAndPlatform(f.id, platform)?.platform_url?.trim(),
      ),
    ])],
    platforms_discarded: f.platforms_discarded,
  })));
};

// ── GET /api/videos/:fileId/thumbnail — miniatura generada con ffmpeg (local) ──
export const getVideoThumbnail = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const file = fileRepo.findById(fileId);
  if (!file || file.status === 'ELIMINADO_DISCO') { res.status(404).end(); return; }
  if (!fs.existsSync(file.file_path)) { res.status(404).end(); return; }

  const hasDimensions = !!(file.formato && file.resolucion);
  const { path: thumb, probed } = await ensureThumbnail(file.id, file.file_path, {
    durationSec: file.duracion_segundos ?? undefined,
    hasDimensions,
  });

  // Backfillea lo que faltaba: sin esto, un reel (9:16) recién agregado se
  // clasificaba "16:9" por default al no tener formato/resolución todavía
  // (esos campos los llenaba solo el plugin de transcripción externo).
  const updates: Partial<{ duracion_segundos: number; formato: string; resolucion: string }> = {};
  if (probed) {
    if (!file.duracion_segundos && probed.durationSec) updates.duracion_segundos = probed.durationSec;
    if (!hasDimensions && probed.width && probed.height) {
      updates.formato    = probed.height > probed.width ? 'VERTICAL' : 'HORIZONTAL';
      updates.resolucion = `${probed.width}x${probed.height}`;
    }
  }
  if (Object.keys(updates).length) fileRepo.update(file.id, updates);
  if (!thumb) { res.status(404).end(); return; }

  // Le avisa al frontend lo ya resuelto (propio o recién probado) para que la
  // fila se autocorrija sin esperar a recargar toda la lista de Videos.
  const durationSec = updates.duracion_segundos ?? file.duracion_segundos ?? 0;
  if (durationSec) res.setHeader('X-Duration-Seconds', String(durationSec));
  const resolucion = updates.resolucion ?? file.resolucion;
  if (resolucion) res.setHeader('X-Resolution', resolucion);

  // Si todavía falta duración o resolución, NO cacheamos: el navegador (fetch)
  // respeta Cache-Control tal cual, así que una respuesta cacheada por 24h con
  // la falla incluida (ffprobe no corrió a tiempo, o falló) se queda pegada
  // para siempre — la próxima carga de la fila nunca vuelve a intentar. Recién
  // cacheamos agresivo cuando ya sabemos que no va a cambiar.
  res.setHeader('Cache-Control', (durationSec && resolucion) ? 'private, max-age=86400' : 'no-store');
  res.sendFile(path.resolve(thumb));
};

// ── GET /api/videos/slim/pending-transcript — usado por esse_transcrip.py ──────
// Filtra en un solo query los que ya tienen transcripción (antes el plugin
// preguntaba archivo por archivo: 1 request HTTP por video, muy lento con miles).
export const getVideoSlimPendingTranscript = (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 2000, 5000);
  const files = fileRepo.findSlimPendingTranscript(limit);
  res.json(files.map(f => ({
    fileId:    String(f.id),
    title:     f.file_name,
    filePath:  f.file_path,
    duration:  f.duracion_segundos ? formatDuration(f.duracion_segundos) : '',
  })));
};

// ── PATCH /api/videos/:fileId/status ─────────────────────────────────────────
export const updateVideoContentStatus = (req: Request, res: Response): void => {
  const { fileId } = req.params;
  const { status } = req.body as { status?: FileContentStatus };
  const valid: FileContentStatus[] = ['publicado', 'borrador', 'procesando', 'descartado'];
  if (!status || !valid.includes(status)) { res.status(400).json({ message: 'Estado inválido.' }); return; }

  const updated = fileRepo.update(fileId, { content_status: status });
  if (!updated) { res.status(404).json({ message: 'Archivo no encontrado.' }); return; }
  res.json({ content_status: status });
};

// ── POST /api/videos/:fileId/push-to-cloud ───────────────────────────────────
// Botón "Subir a la nube" en Videos -- sube ESTE video puntual a Biblioteca
// remota, salteando por completo la cola del calendario (a diferencia de la
// precarga automática de ensurePreloadForNextVideos, que solo sube "el
// próximo a publicar" de cada red). Reusa el mismo camino de subida (normaliza
// para Android si hace falta, TUS si pesa más de 80MB) -- pero acá, a
// diferencia de la precarga, cualquier error (incluido el 409 de cupo lleno
// de la central) se devuelve tal cual al botón, no se traga en un log.
export const pushVideoToCloud = async (req: Request, res: Response): Promise<void> => {
  const { fileId } = req.params;
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ error: 'Token requerido' }); return; }

  const file = fileRepo.findById(fileId);
  if (!file) { res.status(404).json({ error: 'Archivo no encontrado.' }); return; }

  try {
    const remoteLibraryVideoId = await pushVideoToRemoteLibrary(authHeader, file);
    res.json({ ok: true, remoteLibraryVideoId });
  } catch (err: any) {
    // err.message ya trae el texto legible de la central (tusError() /
    // ensureRemoteLibraryCapacity, ver remote-library-storage.service.ts) --
    // uploadToRemoteLibrary no propaga el status code real, solo el mensaje.
    res.status(500).json({ error: err.message || 'No se pudo subir el video a la nube.' });
  }
};

// ── PATCH /api/videos/:fileId/platforms ──────────────────────────────────────
export const updateVideoPlatforms = (req: Request, res: Response): void => {
  const { fileId } = req.params;
  const { platforms, platforms_discarded } = req.body as { platforms?: string[]; platforms_discarded?: string[] };
  const valid = ['youtube', 'instagram', 'tiktok', 'facebook'];
  if (!Array.isArray(platforms) || platforms.some(p => !valid.includes(p))) {
    res.status(400).json({ message: 'Plataformas inválidas.' }); return;
  }
  if (platforms_discarded !== undefined && (!Array.isArray(platforms_discarded) || platforms_discarded.some(p => !valid.includes(p)))) {
    res.status(400).json({ message: 'platforms_discarded inválido.' }); return;
  }
  const before = fileRepo.findById(fileId);
  const data: Parameters<typeof fileRepo.update>[1] = { platforms: platforms as any };
  if (platforms_discarded !== undefined) data.platforms_discarded = platforms_discarded as any;
  const updated = fileRepo.update(fileId, data);
  if (!updated) { res.status(404).json({ message: 'No encontrado.' }); return; }
  // Un cambio manual del badge también debe llegar al espejo central; de lo
  // contrario solo queda en SQLite hasta que el siguiente tick automático
  // consiga ejecutarse.
  pushFilesToCloudInBackground(req.headers.authorization);
  // Un badge también puede ser la confirmación de una publicación externa.
  // Avanzamos la cola y precargamos el siguiente sin inventar un platformId;
  // el enlace real se registra cuando el usuario lo pega en el modal.
  const newlyPublished = (['youtube', 'instagram', 'tiktok'] as Platform[])
    .filter(p => platforms.includes(p) && !(before?.platforms ?? []).includes(p));
  for (const platform of newlyPublished) {
    const nextFile = fileRepo.findNewerAdjacent(updated, platform);
    configRepo.markPublished(platform, updated.file_name, updated.id, nextFile ? String(nextFile.id) : null);
    syncNextVideoToCentral(req.headers.authorization, platform, {
      lastPublishedDate: new Date().toISOString().slice(0, 10),
      lastPublishedTitle: updated.file_name,
      nextFile,
    }).catch(err => console.warn(`[calendar] precarga tras badge falló: ${err.message}`));
  }
  res.json({ platforms, platforms_discarded });
};

export const resolvePublicationSelection = (req: Request, res: Response): void => {
  const { fileId } = req.params;
  const { platforms } = req.body as { platforms?: string[] };
  const valid: Platform[] = ['youtube', 'instagram', 'tiktok'];
  if (!Array.isArray(platforms) || platforms.some(p => !valid.includes(p as Platform))) {
    res.status(400).json({ message: 'Selección de plataformas inválida.' }); return;
  }
  const file = fileRepo.findById(fileId);
  if (!file) { res.status(404).json({ message: 'No encontrado.' }); return; }
  const discarded = valid.filter(p => !platforms.includes(p) && !file.platforms.includes(p));
  const nextDiscarded = [...new Set([...file.platforms_discarded, ...discarded])]
    .filter(p => !platforms.includes(p));
  fileRepo.update(fileId, { platforms_discarded: nextDiscarded as Platform[] });
  pushFilesToCloudInBackground(req.headers.authorization);
  res.json({ platforms: file.platforms, platforms_discarded: nextDiscarded });
};

// ── Extrae el ID nativo de un link pegado a mano — mejora los lookups/dedup,
// pero si no matchea ningún patrón conocido se usa la URL completa como
// platform_id: sigue siendo único y no bloquea al usuario por un formato de
// link que no anticipamos. Guardar la URL cruda como platform_id rompe en
// silencio la sincronización de métricas de ese video (TikTok/etc. necesitan
// el ID real para /video/query/), así que para links acortados de TikTok
// (vm.tiktok.com, tiktok.com/t/...) seguimos el redirect antes de extraer.
const TIKTOK_ID_PATTERN = /tiktok\.com\/@[^/]+\/video\/(\d+)/;
const TIKTOK_SHORT_LINK = /(?:vm\.tiktok\.com\/|tiktok\.com\/t\/)/i;

async function extractPlatformId(platform: string, url: string): Promise<string> {
  const patterns: Record<string, RegExp> = {
    youtube:   /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/,
    instagram: /instagram\.com\/(?:reel|p|tv)\/([a-zA-Z0-9_-]+)/,
    tiktok:    TIKTOK_ID_PATTERN,
  };

  let resolvedUrl = url;
  if (platform === 'tiktok' && TIKTOK_SHORT_LINK.test(url) && !TIKTOK_ID_PATTERN.test(url)) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.url) resolvedUrl = res.url;
    } catch {
      // sin red o link inválido -- se cae al fallback de guardar la URL cruda
    }
  }

  const match = resolvedUrl.match(patterns[platform]);
  return match ? match[1] : url;
}

// ── GET /api/videos/:fileId/platform-links ─────────────────────────────────────
export const getPlatformLinks = (req: Request, res: Response): void => {
  const { fileId } = req.params;
  const platforms: Platform[] = ['youtube', 'instagram', 'tiktok'];
  const links: Record<string, string | null> = {};
  const statuses: Record<string, 'con_link' | 'sin_link' | 'badge_only' | 'pendiente'> = {};
  for (const p of platforms) {
    const publication = platformVideoRepo.findByFileAndPlatform(fileId, p);
    links[p] = publication?.platform_url?.trim() || null;
    statuses[p] = publication
      ? (publication.platform_url?.trim() ? 'con_link' : 'sin_link')
      : (fileRepo.findById(fileId)?.platforms.includes(p) ? 'badge_only' : 'pendiente');
  }
  res.json({ ...links, statuses });
};

// ── PATCH /api/videos/:fileId/platform-link/:platform ──────────────────────────
// Fija/corrige a mano el link de una plataforma puntual sin pasar por el flujo
// de subida — pensado para arreglar un link roto o cargar uno publicado desde
// afuera de la app, directamente desde la vista de Videos.
export const setPlatformLink = async (req: Request, res: Response): Promise<void> => {
  const { fileId, platform } = req.params;
  const { url } = req.body as { url?: string | null };
  const valid: Platform[] = ['youtube', 'instagram', 'tiktok'];
  if (!valid.includes(platform as Platform)) {
    res.status(400).json({ message: 'Plataforma inválida.' }); return;
  }

  const file = fileRepo.findById(fileId);
  if (!file) { res.status(404).json({ message: 'No encontrado.' }); return; }

  const trimmed = url?.trim();
  if (!trimmed) {
    platformVideoRepo.unlinkFromFile(fileId, platform);
    fileRepo.removePlatform(fileId, platform as Platform);
    pushFilesToCloudInBackground(req.headers.authorization);
    // El espejo central es additive para publicaciones nuevas; una limpieza
    // manual necesita este evento explícito para no resucitar en el próximo pull.
    await reportUnlinkPlatform(req.headers.authorization, String(fileId), platform);
    res.json({ platform_url: null, platforms: fileRepo.findById(fileId)!.platforms });
    return;
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    res.status(400).json({ message: 'El link debe empezar con http:// o https://' }); return;
  }

  const platformId = await extractPlatformId(platform, trimmed);
  platformVideoRepo.upsert({
    platform,
    platform_id: platformId,
    platform_url: trimmed,
    linked_file_id: Number(fileId),
    match_status: 'manual',
  });
  fileRepo.addPlatform(fileId, platform as Platform);
  // Deja la nube fresca al instante — mismo patrón que uploadToYoutube: un link
  // corregido a mano es un cambio de estado real, no debería esperar al próximo
  // push manual/automático para reflejarse en el mirror central.
  pushFilesToCloudInBackground(req.headers.authorization);
  // El push de arriba solo llega a files.platforms/platform_videos (el badge y
  // el link que ve OTRO PC al hacer pull) -- nunca a PlatformVideoModel
  // (Sincronizar/Estadísticas) ni al Calendario. Pegarle a record-publish (lo
  // mismo que ya hace cada subida real) cierra ese hueco sin duplicar lógica.
    await reportUploadEvent(req.headers.authorization, {
      platform, platformId, platformUrl: trimmed,
      source: 'pc',
      fileName: file.file_name, contentId: file.content_id, title: file.file_name,
    });
    // La confirmación manual por link equivale a una publicación real:
    // después de que la central actualizó badge/link/calendario, precargar el
    // siguiente video y fijar su ID remoto de forma inmediata.
    const nextFile = fileRepo.findNewerAdjacent(file, platform as Platform);
    await syncNextVideoToCentral(req.headers.authorization, platform as any, {
      lastPublishedDate: new Date().toISOString().slice(0, 10),
      lastPublishedTitle: file.file_name,
      nextFile,
    });
    res.json({ platform_url: trimmed, platforms: fileRepo.findById(fileId)!.platforms });
};

// ── PATCH /api/videos/bulk — edición masiva (plataformas y/o tipo de contenido) ─
export const updateVideosBulk = (req: Request, res: Response): void => {
  const { fileIds, platforms: targetPlatforms, platformState, tipo_contenido } = req.body as {
    fileIds?: string[];
    platforms?: string[];
    platformState?: 'publicado' | 'descartado' | 'pendiente';
    tipo_contenido?: string | null;
  };

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    res.status(400).json({ message: 'fileIds requerido.' }); return;
  }

  const validPlatforms = ['youtube', 'instagram', 'tiktok', 'facebook'];
  if (targetPlatforms !== undefined && (!Array.isArray(targetPlatforms) || targetPlatforms.some(p => !validPlatforms.includes(p)))) {
    res.status(400).json({ message: 'Plataformas inválidas.' }); return;
  }
  const validStates = ['publicado', 'descartado', 'pendiente'];
  if (platformState !== undefined && !validStates.includes(platformState)) {
    res.status(400).json({ message: 'Estado inválido.' }); return;
  }

  let updated = 0;
  for (const fileId of fileIds) {
    const file = fileRepo.findById(fileId);
    if (!file) continue;

    const data: Parameters<typeof fileRepo.update>[1] = {};

    if (targetPlatforms && targetPlatforms.length > 0 && platformState) {
      const ps = targetPlatforms as typeof file.platforms;
      const platforms = file.platforms.filter(x => !ps.includes(x));
      const discarded = file.platforms_discarded.filter(x => !ps.includes(x));
      if (platformState === 'publicado') platforms.push(...ps);
      else if (platformState === 'descartado') discarded.push(...ps);
      data.platforms = platforms;
      data.platforms_discarded = discarded;
    }

    if (tipo_contenido !== undefined) data.tipo_contenido = tipo_contenido;

    if (Object.keys(data).length > 0 && fileRepo.update(fileId, data)) updated++;
  }

  res.json({ updated });

  // Un descarte/publicación cambia qué video sigue disponible para el Calendario.
  // El push de abajo ya replica files.platforms_discarded a FileModel, que es la
  // fuente que getCalendarConfig usa para recalcular el puntero -- pero SOLO lo
  // recalcula quien lea calendar-config después Y note que el puntero guardado
  // quedó obsoleto (autocorrección perezosa). Si ninguna app pide ese GET hasta
  // rato después, mobile se queda mostrando el "próximo" viejo mientras tanto
  // (esto fue justo lo que pasó: un descarte desde Videos dejó a Android/iOS con
  // el próximo de YouTube desactualizado mientras Electron ya mostraba el
  // correcto). Acá avisamos de una, igual que pinVideo/pinNextVideo del
  // Calendario, en vez de esperar a que otro cliente dispare la corrección.
  if (updated > 0 && targetPlatforms && targetPlatforms.length > 0 && platformState) {
    pushFilesToCloudInBackground(req.headers.authorization);

    // Igual que la subida manual (youtube/instagram/tiktok-upload.controller.ts):
    // avisa SIEMPRE, no solo cuando local tenía un override guardado que se
    // invalidó. La central persiste el fallback dinámico como si fuera un
    // override apenas lo calcula una vez (ver autocorrección en
    // getCalendarConfig de backend/src/controllers/sync.controller.ts) -- así
    // que local puede no tener nada fijado (next_video_id null) mientras la
    // central sigue con un valor viejo "endurecido" de una lectura anterior.
    // Chequear solo el estado local para decidir si hace falta avisar no
    // alcanza; más barato avisar de más que quedar desincronizado de nuevo.
    const CALENDAR_PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const;
    const affectedCalendarPlatforms = targetPlatforms.filter(
      (p): p is 'youtube' | 'tiktok' | 'instagram' => (CALENDAR_PLATFORMS as readonly string[]).includes(p),
    );
    for (const platform of affectedCalendarPlatforms) {
      const cfg = configRepo.getPlatformConfig(platform);
      const storedNext = cfg?.next_video_id ? String(cfg.next_video_id) : null;
      const currentNextFile = storedNext
        ? (/^\d+$/.test(storedNext) ? fileRepo.findById(storedNext) : undefined) ?? fileRepo.findByName(storedNext)
        : undefined;
      // Único caso seguro para no avisar: había un "próximo" fijado local Y
      // sigue siendo válido (no es ninguno de los archivos tocados acá) --
      // ahí sabemos con certeza que nada cambió, en cualquiera de los dos lados.
      if (currentNextFile && !fileIds.includes(String(currentNextFile.id))) continue;

      const nextFile = fileRepo.findNextUnpublished(platform);
      configRepo.setPlatformConfig(platform, { next_video_id: nextFile ? String(nextFile.id) : null });
      syncNextVideoToCentral(req.headers.authorization, platform, { nextFile })
        .catch(err => console.warn(`[calendar] aviso de próximo tras descarte/publicación falló: ${err.message}`));
    }
  }
};

// ── PATCH /api/videos/:fileId/rename ─────────────────────────────────────────
export const renameVideo = (req: Request, res: Response): void => {
  const { fileId } = req.params;
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ message: 'Nombre vacío.' }); return; }
  const cleanName = name.trim();

  const doc = fileRepo.findById(fileId);
  if (!doc) { res.status(404).json({ message: 'No encontrado.' }); return; }

  const oldPath = path.resolve(doc.file_path);
  const newPath = path.join(path.dirname(oldPath), cleanName + path.extname(oldPath));
  let diskRenamed = false;
  if (fs.existsSync(oldPath)) { fs.renameSync(oldPath, newPath); diskRenamed = true; }

  fileRepo.update(fileId, {
    file_name: cleanName,
    file_path: diskRenamed ? newPath : doc.file_path,
  });

  res.json({ file_name: cleanName, file_path: diskRenamed ? newPath : doc.file_path, disk_renamed: diskRenamed });
};

// ── DELETE /api/videos/:fileId/delete-file ────────────────────────────────────
export const deleteFileFromDisk = (req: Request, res: Response) => {
  const doc = fileRepo.findById(req.params.fileId);
  if (!doc) return res.status(404).json({ error: 'No encontrado' });
  if (doc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'Ya eliminado' });

  const absPath = path.resolve(doc.file_path);
  if (fs.existsSync(absPath)) fs.unlinkSync(absPath);

  fileRepo.update(req.params.fileId, { status: 'ELIMINADO_DISCO' });
  publishingStatusRepo.deleteByFileId(Number(req.params.fileId));
  // Sin esto quedaban filas de platform_videos huérfanas apuntando a un
  // archivo que ya no existe (linked_file_id sin fila en `files`).
  platformVideoRepo.deleteByFileId(req.params.fileId);
  deleteThumbnail(doc.id);
  // Único endpoint de escritura de este archivo que no lo hacía -- el borrado
  // quedaba esperando al próximo push automático (foco/20min/beforeunload) en
  // vez de reflejarse en la central de inmediato, igual que el resto.
  pushFilesToCloudInBackground(req.headers.authorization);

  res.json({ message: 'Archivo eliminado del disco' });
};

// ── GET /api/videos/:fileId/player-data ──────────────────────────────────────
export const getVideoPlayerData = async (req: Request, res: Response): Promise<void> => {
  const doc = fileRepo.findById(req.params.fileId);
  if (!doc) { res.status(404).json({ message: 'No encontrado.' }); return; }

  // Sin duracion_segundos/formato/resolución todavía (el plugin de transcripción
  // no los calculó): los probamos con ffprobe acá mismo, en vez de dejar que el
  // frontend estime una duración falsa ("0:15" fijo) o asuma "16:9" por default.
  let durationSec = doc.duracion_segundos ?? 0;
  let formato      = doc.formato;
  let resolucion   = doc.resolucion;
  const hasDimensions = !!(formato && resolucion);
  if ((!durationSec || !hasDimensions) && fs.existsSync(doc.file_path)) {
    const probed = await probeVideoInfo(doc.file_path);
    const updates: Partial<{ duracion_segundos: number; formato: string; resolucion: string }> = {};
    if (!durationSec && probed.durationSec) { durationSec = probed.durationSec; updates.duracion_segundos = probed.durationSec; }
    if (!hasDimensions && probed.width && probed.height) {
      formato    = probed.height > probed.width ? 'VERTICAL' : 'HORIZONTAL';
      resolucion = `${probed.width}x${probed.height}`;
      updates.formato = formato;
      updates.resolucion = resolucion;
    }
    if (Object.keys(updates).length) fileRepo.update(doc.id, updates);
  }

  const tr = transcriptRepo.findByFileId(doc.id);
  res.json({
    file: {
      _id: String(doc.id),
      file_name: doc.file_name,
      duration_seconds: durationSec,
      formato: formato ?? 'HORIZONTAL',
      resolucion: resolucion ?? '',
    },
    transcript: tr ? {
      _id: String(doc.id),
      transcript_text: tr.text,
      tipo_contenido: doc.tipo_contenido ?? null,
      palabras_por_minuto: 0,
      language: tr.language,
    } : null,
    script: null,
  });
};

// ── GET /api/metrics ──────────────────────────────────────────────────────────
export const getMetrics = (_req: Request, res: Response) => {
  const totalVideos = fileRepo.countAll();
  res.json({ totalVideos, guionesEstructurados: 0, clipsRandom: 0, clipsSinVoz: 0 });
};

// ── GET /api/calendar?year=&month= — mirror local de getCalendarVideos (central) ──
// Nunca existió en local-backend: la llamada del Dashboard/Calendario caía en el
// catch-all de Express que sirve el index.html de la SPA (200, pero HTML en vez
// de JSON), lo que hacía fallar el JSON.parse del lado del frontend y tumbaba
// TODO el Promise.all del Dashboard -- forzando el modo demo aunque group-stats
// e historial sí tuvieran datos reales. Bug real confirmado en producción el
// 2026-07-28.
export const getCalendarVideos = (req: Request, res: Response): void => {
  const now = new Date();
  const year  = parseInt(req.query.year  as string) || now.getFullYear();
  const month = parseInt(req.query.month as string) || (now.getMonth() + 1);

  const rows = fileRepo.findForCalendar(year, month);
  const videos = rows.map(r => {
    let platforms: string[];
    try { platforms = JSON.parse(r.platforms || '[]'); } catch { platforms = []; }
    return {
      _id: String(r.id),
      fileId: String(r.id),
      title: r.file_name,
      date: r.effective_date,
      content_status: r.content_status || 'borrador',
      target_platforms: platforms,
      published_platforms: platforms,
      tipo_contenido: r.tipo_contenido ?? undefined,
      duracion_segundos: r.duracion_segundos ?? undefined,
      scheduled_date: r.scheduled_date ?? undefined,
    };
  });
  res.json({ videos });
};

// ── PATCH /api/videos/:fileId/scheduled-date ─────────────────────────────────
export const updateScheduledDate = (req: Request, res: Response): void => {
  const { scheduled_date } = req.body as { scheduled_date?: string | null };
  const updated = fileRepo.update(req.params.fileId, {
    scheduled_date: scheduled_date ?? null,
  });
  if (!updated) { res.status(404).json({ message: 'No encontrado.' }); return; }
  const doc = fileRepo.findById(req.params.fileId);
  res.json({ scheduled_date: doc?.scheduled_date ?? null });
};

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ── POST /api/videos/resolve-by-name — resuelve file_name → id local ──────────
// La central (Mongo) espeja el catálogo con SU PROPIO _id (ObjectId), distinto
// del id numérico de SQLite acá. El único campo en común es file_name, así que
// cualquier feature que necesite mostrar miniatura/reproductor a partir de un
// resultado de la central (ej. el panel de emparejar plataformas) pasa por acá.
export const resolveFilesByName = (req: Request, res: Response): void => {
  const names = (req.body?.names ?? []) as string[];
  if (!Array.isArray(names)) { res.status(400).json({ message: 'names[] requerido' }); return; }

  const result: Record<string, string | null> = {};
  for (const name of names) {
    const file = fileRepo.findByName(name);
    result[name] = file ? String(file.id) : null;
  }
  res.json(result);
};
