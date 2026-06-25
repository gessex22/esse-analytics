import { Response } from 'express';
import fs from 'fs';
import { AuthRequest } from '../middleware/auth.middleware';
import { fileRepo } from '../db/file.repo';
import { platformVideoRepo } from '../db/platform-video.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

async function fetchAccessToken(authHeader: string): Promise<string> {
  const res = await fetch(`${CENTRAL}/api/youtube/token`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) throw new Error('NO_AUTH');
  const data = await res.json() as { access_token: string };
  return data.access_token;
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

  const fileBuffer = fs.readFileSync(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/*', 'Content-Length': String(fileSize) },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Error subiendo video: ${err}`);
  }

  const data = await uploadRes.json() as { id: string; snippet?: { title?: string } };
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

  try {
    const result = await uploadVideoToYoutube(accessToken, filePath, {
      title, description, tags, categoryId, privacyStatus,
      madeForKids: Boolean(madeForKids),
      ageRestricted: Boolean(ageRestricted),
      publishAt,
    });

    platformVideoRepo.upsert({
      platform:      'youtube',
      platform_id:   result.videoId,
      platform_url:  result.videoUrl,
      published_at:  new Date(),
      linked_file_id: Number(fileId),
      match_status:  'manual',
    });

    fileRepo.update(fileId, { content_status: 'publicado' });
    fileRepo.addPlatform(fileId, 'youtube');

    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('Error local YouTube upload:', err.message);
    res.status(500).json({ error: 'Error al subir el video', detail: err.message });
  }
};
