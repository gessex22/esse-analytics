import { Response } from 'express';
import fs from 'fs';
import { AuthRequest } from '../middleware/auth.middleware';
import { fileRepo } from '../db/file.repo';
import { platformVideoRepo } from '../db/platform-video.repo';
import { configRepo } from '../db/config.repo';
import { pushFilesToCloudInBackground } from './backup-sync.controller';
import { syncNextVideoToCentral } from '../services/calendar-sync.service';
import { setUploadProgress, clearUploadProgress, setUploadError } from '../state/upload-activity';

const CENTRAL     = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
const CHUNK_SIZE  = 8 * 1024 * 1024; // 8 MiB, múltiplo de 256 KiB (requisito de YouTube resumable)

async function fetchAccessToken(authHeader: string): Promise<string> {
  const res = await fetch(`${CENTRAL}/api/youtube/token`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) throw new Error('NO_AUTH');
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// Sube el archivo a la uploadUrl resumable en chunks de CHUNK_SIZE, reportando
// el % de bytes enviados vía onProgress tras cada chunk aceptado.
async function uploadChunks(
  uploadUrl: string,
  filePath: string,
  fileSize: number,
  onProgress: (percent: number) => void,
): Promise<{ id: string; snippet?: { title?: string } }> {
  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    while (offset < fileSize) {
      const end  = Math.min(offset + CHUNK_SIZE, fileSize) - 1;
      const size = end - offset + 1;
      const buf  = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, offset);

      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type':   'video/*',
          'Content-Length': String(size),
          'Content-Range':  `bytes ${offset}-${end}/${fileSize}`,
        },
        body: buf,
      });

      offset = end + 1;
      onProgress(Math.round((offset / fileSize) * 100));

      if (res.status === 308) continue; // chunk aceptado, YouTube pide seguir
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Error subiendo video (chunk): ${err}`);
      }
      return await res.json() as { id: string; snippet?: { title?: string } };
    }
    throw new Error('La subida terminó sin respuesta final de YouTube');
  } finally {
    fs.closeSync(fd);
  }
}

async function uploadVideoToYoutube(
  accessToken: string,
  filePath: string,
  metadata: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    privacyStatus: string;
    madeForKids: boolean;
    ageRestricted: boolean;
    publishAt?: string;
  },
  onProgress: (percent: number) => void,
): Promise<{ videoId: string; videoUrl: string; title: string }> {
  const fileSize = fs.statSync(filePath).size;

  const snippetBody: Record<string, any> = {
    title: metadata.title,
    description: metadata.description,
    tags: metadata.tags,
    categoryId: metadata.categoryId,
    defaultLanguage: 'es',
  };
  if (metadata.ageRestricted) snippetBody.contentRating = { ytRating: 'ytAgeRestricted' };

  const statusBody: Record<string, any> = {
    privacyStatus: metadata.publishAt ? 'private' : metadata.privacyStatus,
    selfDeclaredMadeForKids: metadata.madeForKids,
  };
  if (metadata.publishAt) statusBody.publishAt = metadata.publishAt;

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/*',
        'X-Upload-Content-Length': String(fileSize),
      },
      body: JSON.stringify({ snippet: snippetBody, status: statusBody }),
    },
  );

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`Error iniciando upload: ${err}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('No se recibió upload URL de YouTube');

  const data = await uploadChunks(uploadUrl, filePath, fileSize, onProgress);
  return {
    videoId: data.id,
    videoUrl: `https://www.youtube.com/shorts/${data.id}`,
    title: data.snippet?.title ?? metadata.title,
  };
}

// ── POST /api/youtube/upload ──────────────────────────────────────────────────
export const uploadToYoutube = async (req: AuthRequest, res: Response) => {
  const {
    fileId,
    title,
    description = '',
    tags = [],
    categoryId = '22',
    privacyStatus = 'public',
    madeForKids = false,
    ageRestricted = false,
    publishAt,
  } = req.body;

  if (!fileId || !title) return res.status(400).json({ error: 'fileId y title son requeridos' });

  const fileDoc = fileRepo.findById(fileId);
  if (!fileDoc) return res.status(404).json({ error: 'Archivo no encontrado' });
  if (fileDoc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo fue eliminado del disco' });

  const filePath = fileDoc.file_path;
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Archivo físico no encontrado en disco' });

  let accessToken: string;
  try {
    accessToken = await fetchAccessToken(req.headers.authorization!);
  } catch {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de YouTube primero' });
  }

  const jobId = `youtube-${fileId}`;
  try {
    const result = await uploadVideoToYoutube(accessToken, filePath, {
      title, description, tags, categoryId, privacyStatus,
      madeForKids: Boolean(madeForKids),
      ageRestricted: Boolean(ageRestricted),
      publishAt,
    }, (percent) => setUploadProgress(jobId, { platform: 'youtube', title, phase: 'uploading', percent }));

    platformVideoRepo.upsert({
      platform:      'youtube',
      platform_id:   result.videoId,
      platform_url:  result.videoUrl,
      published_at:  new Date(),
      linked_file_id: Number(fileId),
      match_status:  'manual',
      title:         result.title?.slice(0, 300) || title?.slice(0, 300) || undefined,
    });

    fileRepo.update(fileId, { content_status: 'publicado' });
    fileRepo.addPlatform(fileId, 'youtube');
    // Flujo simple: la subida es un evento único — las demás plataformas que
    // sigan pendientes para este video se resuelven como descartadas.
    if (configRepo.get('workflow_mode') === 'simple') fileRepo.resolveOthersAsDiscarded(fileId, 'youtube');
    const nextYt = fileRepo.findNewerAdjacent(fileDoc);
    configRepo.markPublished('youtube', fileDoc.file_name, fileId, nextYt ? String(nextYt.id) : null);
    syncNextVideoToCentral(req.headers.authorization, 'youtube', {
      lastPublishedDate:  new Date().toISOString().slice(0, 10),
      lastPublishedTitle: fileDoc.file_name,
      nextVideoTitle:     nextYt?.file_name ?? null,
    });
    pushFilesToCloudInBackground(req.headers.authorization);

    clearUploadProgress(jobId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('Error local YouTube upload:', err.message);
    setUploadError(jobId, { platform: 'youtube', title, message: err.message });
    res.status(500).json({ error: 'Error al subir el video', detail: err.message });
  }
};

// ── POST /api/youtube/thumbnail/:videoId ──────────────────────────────────────
export const setThumbnail = async (req: AuthRequest, res: Response) => {
  const { videoId } = req.params;
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 requerido' });

  let accessToken: string;
  try {
    accessToken = await fetchAccessToken(req.headers.authorization!);
  } catch {
    return res.status(401).json({ error: 'NO_AUTH' });
  }

  const base64Data = (imageBase64 as string).replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  try {
    const uploadRes = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'image/jpeg',
          'Content-Length': String(buffer.length),
        },
        body: buffer,
      },
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(err);
    }

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error al subir miniatura (local):', err.message);
    res.status(500).json({ error: 'Error al subir miniatura', detail: err.message });
  }
};
