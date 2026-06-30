import { Request, Response } from 'express';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { PlatformVideoModel } from '../models/platform-video.model';
import { markPlatformLinked } from '../models/user.model';
import { encodeState, decodeState } from '../utils/oauth-state';
import { AuthRequest } from '../middleware/auth.middleware';

export const remoteUploadMiddleware = multer({
  dest: path.join(os.tmpdir(), 'esse-uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('video/'));
  },
});

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

// ── Token storage per user ────────────────────────────────────────────────────
async function saveTokens(userId: string, tokens: object) {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').updateOne(
    { provider: 'youtube', userId },
    { $set: { provider: 'youtube', userId, tokens, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function loadTokens(userId: string): Promise<any | null> {
  const db = mongoose.connection.db!;
  const doc = await db.collection('oauth_tokens').findOne({ provider: 'youtube', userId });
  return doc?.tokens ?? null;
}

async function getAuthorizedClient(userId: string) {
  const oauth2 = getOAuth2Client();
  const tokens = await loadTokens(userId);
  if (!tokens) throw new Error('NO_AUTH');
  oauth2.setCredentials(tokens);

  oauth2.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(userId, merged);
    oauth2.setCredentials(merged);
  });

  return oauth2;
}

// ── GET /api/youtube/auth/url ─────────────────────────────────────────────────
export const getAuthUrl = (req: AuthRequest, res: Response) => {
  const oauth2 = getOAuth2Client();
  const origin = req.query.origin as string | undefined;
  const state = encodeState(req.user!.id, origin);
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
  res.json({ url });
};

// ── GET /api/youtube/auth/callback ────────────────────────────────────────────
export const handleCallback = async (req: Request, res: Response) => {
  const code  = req.query.code  as string;
  const state = req.query.state as string;

  if (!code || !state) {
    const fallback = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.redirect(`${fallback}?youtube_auth=error`);
  }

  const { userId, origin } = decodeState(state);

  try {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    await saveTokens(userId, tokens);
    res.redirect(`${origin}?youtube_auth=success`);
  } catch (err: any) {
    console.error('YouTube OAuth callback error:', err.message);
    res.redirect(`${origin}?youtube_auth=error`);
  }
};

// ── GET /api/youtube/auth/status ──────────────────────────────────────────────
export const getAuthStatus = async (req: AuthRequest, res: Response) => {
  const tokens = await loadTokens(req.user!.id);
  res.json({ connected: !!tokens });
};

// ── GET /api/youtube/token ────────────────────────────────────────────────────
// Devuelve un access_token fresco para que local-backend pueda subir directamente.
export const getYoutubeToken = async (req: AuthRequest, res: Response) => {
  const tokens = await loadTokens(req.user!.id);
  if (!tokens) return res.status(404).json({ error: 'NO_AUTH' });

  try {
    const oauth2 = getOAuth2Client();
    oauth2.setCredentials(tokens);
    const { credentials } = await oauth2.refreshAccessToken();
    await saveTokens(req.user!.id, credentials);
    res.json({ access_token: credentials.access_token });
  } catch (err: any) {
    res.status(500).json({ error: 'Error al refrescar el token', detail: err.message });
  }
};

// ── GET /api/youtube/channel-info ─────────────────────────────────────────────
export const getChannelInfo = async (req: AuthRequest, res: Response) => {
  let oauth2: any;
  try {
    oauth2 = await getAuthorizedClient(req.user!.id);
  } catch {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de YouTube primero' });
  }

  try {
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });
    const resp = await youtube.channels.list({ part: ['snippet'], mine: true });
    const ch = resp.data.items?.[0];
    if (!ch) return res.status(404).json({ error: 'No se encontró el canal' });

    const name      = ch.snippet?.title ?? '';
    const customUrl = ch.snippet?.customUrl ?? '';
    const avatarUrl = ch.snippet?.thumbnails?.default?.url ?? ch.snippet?.thumbnails?.medium?.url ?? '';

    // Marca la plataforma como vinculada (primera vinculación = cuenta verificada)
    await markPlatformLinked(req.user!.id, 'youtube', name).catch(() => {});
    if (customUrl) {
      const { UserModel } = await import('../models/user.model');
      await UserModel.findByIdAndUpdate(req.user!.id, { youtubeChannelUrl: `https://youtube.com/${customUrl}` }).catch(() => {});
    }

    res.json({ name, avatarUrl, customUrl });
  } catch (err: any) {
    console.error('Error YouTube channel-info:', err?.message);
    res.status(500).json({ error: 'Error al obtener info del canal', detail: err?.message });
  }
};

// ── DELETE /api/youtube/auth ──────────────────────────────────────────────────
export const revokeAuth = async (req: AuthRequest, res: Response) => {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').deleteOne({ provider: 'youtube', userId: req.user!.id });
  res.json({ ok: true });
};

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

  if (!fileId || !title) {
    return res.status(400).json({ error: 'fileId y title son requeridos' });
  }

  const fileDoc = await FileModel.findOne({ _id: fileId, userId: req.user!.id }).lean();
  if (!fileDoc) return res.status(404).json({ error: 'Archivo no encontrado' });
  if (fileDoc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo fue eliminado del disco' });

  const filePath = fileDoc.file_path as string;
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Archivo físico no encontrado en disco' });

  let oauth2: any;
  try {
    oauth2 = await getAuthorizedClient(req.user!.id);
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

    await FileModel.findByIdAndUpdate(fileId, {
      $set: { content_status: 'publicado' },
      $addToSet: { platforms: 'youtube' },
    });

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

// ── POST /api/youtube/upload/remote ──────────────────────────────────────────
// Recibe el archivo via multipart, lo sube a YouTube y lo borra del servidor.
// Disponible para todos los usuarios (free en red local, premium en remoto).
export const remoteUploadToYoutube = async (req: AuthRequest, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;

  if (!file) return res.status(400).json({ error: 'No se recibió ningún archivo de video' });

  const {
    title,
    description = '',
    tags,
    categoryId = '22',
    privacyStatus = 'public',
    madeForKids = 'false',
    ageRestricted = 'false',
    publishAt,
  } = req.body;

  if (!title) {
    fs.unlink(file.path, () => {});
    return res.status(400).json({ error: 'title es requerido' });
  }

  let oauth2: any;
  try {
    oauth2 = await getAuthorizedClient(req.user!.id);
  } catch {
    fs.unlink(file.path, () => {});
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de YouTube primero' });
  }

  const youtube = google.youtube({ version: 'v3', auth: oauth2 });

  const parsedTags = (() => {
    try { return typeof tags === 'string' ? JSON.parse(tags) : tags ?? []; }
    catch { return []; }
  })();

  const statusBody: Record<string, any> = {
    privacyStatus: publishAt ? 'private' : privacyStatus,
    selfDeclaredMadeForKids: madeForKids === 'true',
  };
  if (publishAt) statusBody.publishAt = publishAt;

  try {
    const snippetBody: Record<string, any> = {
      title,
      description,
      tags: parsedTags,
      categoryId,
      defaultLanguage: 'es',
    };
    if (ageRestricted === 'true') snippetBody.contentRating = { ytRating: 'ytAgeRestricted' };

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: { snippet: snippetBody, status: statusBody },
      media: { body: fs.createReadStream(file.path) },
    } as any);

    const videoId = response.data.id;
    const videoUrl = `https://www.youtube.com/shorts/${videoId}`;

    await PlatformVideoModel.findOneAndUpdate(
      { platform: 'youtube', platformId: videoId },
      { userId: req.user!.id, platform: 'youtube', platformId: videoId, platformUrl: videoUrl, publishedAt: new Date(), matchStatus: 'remote' },
      { upsert: true },
    );

    res.json({ ok: true, videoId, videoUrl, title: response.data.snippet?.title });
  } catch (err: any) {
    console.error('Error remote upload YouTube:', err?.response?.data ?? err.message);
    res.status(500).json({
      error: 'Error al subir el video',
      detail: err?.response?.data?.error?.message ?? err.message,
    });
  } finally {
    fs.unlink(file.path, () => {});
  }
};

// ── POST /api/youtube/thumbnail/:videoId ──────────────────────────────────────
export const setThumbnail = async (req: AuthRequest, res: Response) => {
  const { videoId } = req.params;
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 requerido' });

  let oauth2: any;
  try {
    oauth2 = await getAuthorizedClient(req.user!.id);
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
