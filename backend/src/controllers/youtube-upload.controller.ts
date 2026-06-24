import { Request, Response } from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { PlatformVideoModel } from '../models/platform-video.model';

// ── OAuth2 client ─────────────────────────────────────────────────────────────
const getOAuth2Client = () => new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:4000/api/youtube/auth/callback',
);

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
];

// ── Token storage en MongoDB ──────────────────────────────────────────────────
async function saveTokens(tokens: object) {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').updateOne(
    { provider: 'youtube' },
    { $set: { provider: 'youtube', tokens, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function loadTokens(): Promise<any | null> {
  const db = mongoose.connection.db!;
  const doc = await db.collection('oauth_tokens').findOne({ provider: 'youtube' });
  return doc?.tokens ?? null;
}

async function getAuthorizedClient() {
  const oauth2 = getOAuth2Client();
  const tokens = await loadTokens();
  if (!tokens) throw new Error('NO_AUTH');
  oauth2.setCredentials(tokens);

  // Refresca el access token si expiró
  oauth2.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
    oauth2.setCredentials(merged);
  });

  return oauth2;
}

// ── GET /api/youtube/auth/url ─────────────────────────────────────────────────
export const getAuthUrl = (_req: Request, res: Response) => {
  const oauth2 = getOAuth2Client();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.json({ url });
};

// ── GET /api/youtube/auth/callback ────────────────────────────────────────────
export const handleCallback = async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).json({ error: 'Código de autorización faltante' });

  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);
  await saveTokens(tokens);

  // Redirige al frontend con señal de éxito
  const origin = process.env.FRONTEND_URL || 'http://localhost:5173';
  res.redirect(`${origin}?youtube_auth=success`);
};

// ── GET /api/youtube/auth/status ──────────────────────────────────────────────
export const getAuthStatus = async (_req: Request, res: Response) => {
  const tokens = await loadTokens();
  res.json({ connected: !!tokens });
};

// ── GET /api/youtube/channel-info ─────────────────────────────────────────────
export const getChannelInfo = async (_req: Request, res: Response) => {
  let oauth2: any;
  try {
    oauth2 = await getAuthorizedClient();
  } catch {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de YouTube primero' });
  }

  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    const resp = await youtube.channels.list({ part: ['snippet'], mine: true });
    const ch = resp.data.items?.[0];
    if (!ch) return res.status(404).json({ error: 'No se encontró el canal' });

    res.json({
      name:      ch.snippet?.title ?? '',
      avatarUrl: ch.snippet?.thumbnails?.default?.url
              ?? ch.snippet?.thumbnails?.medium?.url
              ?? '',
      customUrl: ch.snippet?.customUrl ?? '',
    });
  } catch (err: any) {
    console.error('Error YouTube channel-info:', err?.message);
    res.status(500).json({ error: 'Error al obtener info del canal', detail: err?.message });
  }
};

// ── DELETE /api/youtube/auth ──────────────────────────────────────────────────
export const revokeAuth = async (_req: Request, res: Response) => {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').deleteOne({ provider: 'youtube' });
  res.json({ ok: true });
};

// ── POST /api/youtube/upload ──────────────────────────────────────────────────
export const uploadToYoutube = async (req: Request, res: Response) => {
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

  if (!fileId || !title) {
    return res.status(400).json({ error: 'fileId y title son requeridos' });
  }

  // Carga el archivo físico
  const fileDoc = await FileModel.findById(fileId).lean();
  if (!fileDoc) return res.status(404).json({ error: 'Archivo no encontrado' });
  if (fileDoc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo fue eliminado del disco' });

  const filePath = fileDoc.file_path as string;
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Archivo físico no encontrado en disco' });

  let oauth2: any;
  try {
    oauth2 = await getAuthorizedClient();
  } catch {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de YouTube primero' });
  }

  const youtube = google.youtube({ version: 'v3', auth: oauth2 });

  const statusBody: Record<string, any> = {
    privacyStatus: publishAt ? 'private' : privacyStatus,
    selfDeclaredMadeForKids: madeForKids,
  };
  if (publishAt) statusBody.publishAt = publishAt;

  try {
    const snippetBody: Record<string, any> = {
      title,
      description,
      tags,
      categoryId,
      defaultLanguage: 'es',
    };
    if (ageRestricted) {
      snippetBody.contentRating = { ytRating: 'ytAgeRestricted' };
    }

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: snippetBody,
        status: statusBody,
      },
      media: {
        body: fs.createReadStream(filePath),
      },
    } as any);

    const videoId = response.data.id;
    const videoUrl = `https://www.youtube.com/shorts/${videoId}`;

    await PlatformVideoModel.findOneAndUpdate(
      { platform: 'youtube', platformId: videoId },
      { platform: 'youtube', platformId: videoId, platformUrl: videoUrl, publishedAt: new Date(), linkedFileId: fileId, matchStatus: 'manual' },
      { upsert: true },
    );

    res.json({
      ok: true,
      videoId,
      videoUrl,
      title: response.data.snippet?.title,
    });
  } catch (err: any) {
    console.error('Error al subir a YouTube:', err?.response?.data ?? err.message);
    res.status(500).json({
      error: 'Error al subir el video',
      detail: err?.response?.data?.error?.message ?? err.message,
    });
  }
};

// ── POST /api/youtube/thumbnail/:videoId ──────────────────────────────────────
export const setThumbnail = async (req: Request, res: Response) => {
  const { videoId } = req.params;
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 requerido' });

  let oauth2: any;
  try {
    oauth2 = await getAuthorizedClient();
  } catch {
    return res.status(401).json({ error: 'NO_AUTH' });
  }

  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  const base64Data = (imageBase64 as string).replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const { Readable } = await import('stream');
  const stream = Readable.from(buffer);

  try {
    await youtube.thumbnails.set({
      videoId,
      media: { mimeType: 'image/jpeg', body: stream },
    });
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error al subir miniatura:', err?.response?.data ?? err.message);
    res.status(500).json({
      error: 'Error al subir miniatura',
      detail: err?.response?.data?.error?.message ?? err.message,
    });
  }
};
