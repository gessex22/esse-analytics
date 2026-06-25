import { Response } from 'express';
import fs from 'fs';
import { AuthRequest } from '../middleware/auth.middleware';
import { FileModel } from '../models/file.model';
import { PlatformVideoModel } from '../models/platform-video.model';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

async function fetchAccessToken(authHeader: string): Promise<string> {
  const res = await fetch(`${CENTRAL}/api/youtube/token`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) throw new Error('NO_AUTH');
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// Resumable upload to YouTube Data API v3 using plain fetch (no googleapis dep needed)
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

  // Step 1: Initiate resumable upload
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

  // Step 2: Upload the file
  const fileBuffer = fs.readFileSync(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/*',
      'Content-Length': String(fileSize),
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Error subiendo video: ${err}`);
  }

  const data = await uploadRes.json() as { id: string; snippet?: { title?: string } };
  const videoId = data.id;
  return {
    videoId,
    videoUrl: `https://www.youtube.com/shorts/${videoId}`,
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

  const fileDoc = await FileModel.findById(fileId).lean();
  if (!fileDoc) return res.status(404).json({ error: 'Archivo no encontrado' });
  if ((fileDoc as any).status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo fue eliminado del disco' });

  const filePath = (fileDoc as any).file_path as string;
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

    await PlatformVideoModel.findOneAndUpdate(
      { platform: 'youtube', platformId: result.videoId },
      {
        platform: 'youtube',
        platformId: result.videoId,
        platformUrl: result.videoUrl,
        publishedAt: new Date(),
        linkedFileId: fileId,
        matchStatus: 'manual',
      },
      { upsert: true },
    );

    await FileModel.findByIdAndUpdate(fileId, {
      $set: { content_status: 'publicado' },
      $addToSet: { platforms: 'youtube' },
    });

    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('Error local YouTube upload:', err.message);
    res.status(500).json({ error: 'Error al subir el video', detail: err.message });
  }
};
