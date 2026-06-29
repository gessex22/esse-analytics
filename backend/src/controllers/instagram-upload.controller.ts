import { Request, Response } from 'express';
import fs from 'fs';
import https from 'https';
import http from 'http';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { PlatformVideoModel } from '../models/platform-video.model';
import { AuthRequest } from '../middleware/auth.middleware';
import { encodeState, decodeState } from '../utils/oauth-state';

// Instagram Business Login usa graph.instagram.com, no graph.facebook.com
const IG_GRAPH  = 'https://graph.instagram.com/v22.0';
const IG_OAUTH  = 'https://api.instagram.com/oauth/access_token';
const IG_AUTH   = 'https://www.instagram.com/oauth/authorize';
const IG_LTOKEN = 'https://graph.instagram.com/access_token';

// ── Token storage per user ────────────────────────────────────────────────────
async function saveTokens(userId: string, data: object) {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').updateOne(
    { provider: 'instagram', userId },
    { $set: { provider: 'instagram', userId, ...data, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function loadTokens(userId: string): Promise<Record<string, any> | null> {
  const db = mongoose.connection.db!;
  const doc = await db.collection('oauth_tokens').findOne({ provider: 'instagram', userId });
  return doc ?? null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function igGet(path: string, token: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${IG_GRAPH}${path}${sep}access_token=${token}`);
  return res.json();
}

// La Graph API de Meta espera los parámetros como form-urlencoded, no JSON.
async function igPost(path: string, body: Record<string, any>): Promise<any> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`${IG_GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return res.json();
}

// Streams a local file to the Meta Resumable Upload endpoint
function streamFileToMeta(uri: string, token: string, filePath: string, fileSize: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(uri);
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        Authorization:    `OAuth ${token}`,
        offset:           '0',
        file_size:        String(fileSize),
        'Content-Type':   'video/mp4',
        'Content-Length': String(fileSize),
      },
    }, (incoming) => {
      let raw = '';
      incoming.on('data', c => (raw += c));
      incoming.on('end', () => {
        if ((incoming.statusCode ?? 0) >= 400) {
          reject(new Error(`Meta upload ${incoming.statusCode}: ${raw}`));
        } else {
          resolve();
        }
      });
    });

    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
}

// Instagram Business Login usa el Instagram App ID/Secret (distintos a los de Facebook)
const igAppId     = () => process.env.INSTAGRAM_APP_ID     || process.env.META_APP_ID!;
const igAppSecret = () => process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET!;

// Devuelve una página que avisa a la ventana padre y se cierra (o redirige si no es popup)
function popupResult(res: Response, status: string, origin = process.env.FRONTEND_URL || 'http://localhost:5173') {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;background:#0c0c14;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>Conectando con Instagram… puedes cerrar esta ventana.</p>
<script>(function(){
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ source: 'instagram_auth', status: ${JSON.stringify(status)} }, '*');
      window.close();
      return;
    }
  } catch (e) {}
  window.location.replace(${JSON.stringify(origin)} + '/?instagram_auth=' + ${JSON.stringify(status)});
})();</script>
</body></html>`);
}

// ── GET /api/instagram/token — devuelve token válido al local-backend ─────────
export const getToken = async (req: AuthRequest, res: Response) => {
  const tokens = await loadTokens(req.user!.id);
  if (!tokens?.access_token || !tokens?.instagram_user_id) {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
  }
  res.json({ access_token: tokens.access_token, instagram_user_id: tokens.instagram_user_id });
};

// ── GET /api/instagram/auth/url ───────────────────────────────────────────────
export const getAuthUrl = (req: AuthRequest, res: Response) => {
  const origin = req.query.origin as string | undefined;
  const state = encodeState(req.user!.id, origin);
  const params = new URLSearchParams({
    client_id:     igAppId(),
    redirect_uri:  process.env.META_REDIRECT_URI!,
    scope:         'instagram_business_basic,instagram_business_content_publish',
    response_type: 'code',
    state,
  });
  res.json({ url: `${IG_AUTH}?${params}` });
};

// ── GET /api/instagram/auth/callback ─────────────────────────────────────────
export const handleCallback = async (req: Request, res: Response) => {
  const code  = req.query.code  as string;
  const state = req.query.state as string;
  if (!code || !state) return popupResult(res, 'error');

  const { userId, origin } = decodeState(state);
  if (!userId) return popupResult(res, 'error', origin);

  try {
    // 1. Exchange code → short-lived token (POST, form-encoded)
    const tokenRes = await fetch(IG_OAUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     igAppId(),
        client_secret: igAppSecret(),
        grant_type:    'authorization_code',
        redirect_uri:  process.env.META_REDIRECT_URI!,
        code,
      }),
    });
    const tokenJson = await tokenRes.json() as any;
    if (tokenJson.error_type || tokenJson.error) {
      throw new Error(tokenJson.error_message || tokenJson.error);
    }
    const shortToken: string = tokenJson.access_token;
    const igUserId: string   = String(tokenJson.user_id);

    // 2. Exchange for long-lived token (~60 days)
    const longRes = await fetch(
      `${IG_LTOKEN}?grant_type=ig_exchange_token&client_secret=${igAppSecret()}&access_token=${shortToken}`
    );
    const longJson = await longRes.json() as any;
    if (longJson.error) throw new Error(longJson.error.message ?? JSON.stringify(longJson.error));
    const longToken: string = longJson.access_token;

    // El user_id del intercambio de token NO sirve para la Graph API.
    const meRes  = await fetch(`${IG_GRAPH}/me?fields=user_id&access_token=${longToken}`);
    const meJson = await meRes.json() as any;
    const realUserId: string = String(meJson.user_id ?? igUserId);

    if (!realUserId) return popupResult(res, 'no_ig_account', origin);

    await saveTokens(userId, { access_token: longToken, instagram_user_id: realUserId });
    popupResult(res, 'success', origin);
  } catch (err: any) {
    console.error('Instagram OAuth error:', err.message);
    popupResult(res, 'error', origin);
  }
};

// ── GET /api/instagram/auth/status ───────────────────────────────────────────
export const getAuthStatus = async (req: AuthRequest, res: Response) => {
  const tokens = await loadTokens(req.user!.id);
  res.json({ connected: !!(tokens?.access_token && tokens?.instagram_user_id) });
};

// ── DELETE /api/instagram/auth ────────────────────────────────────────────────
export const revokeAuth = async (req: AuthRequest, res: Response) => {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').deleteOne({ provider: 'instagram', userId: req.user!.id });
  res.json({ ok: true });
};

// ── GET /api/instagram/account-info ───────────────────────────────────────────
export const getAccountInfo = async (req: AuthRequest, res: Response) => {
  const tokens = await loadTokens(req.user!.id);
  if (!tokens?.access_token) {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
  }
  try {
    const data = await igGet('/me?fields=user_id,username,name,profile_picture_url', tokens.access_token);
    if (data.error) throw new Error(data.error.message ?? 'Error al obtener la cuenta');
    res.json({
      name:      data.name ?? data.username ?? '',
      username:  data.username ?? '',
      avatarUrl: data.profile_picture_url ?? '',
    });
  } catch (err: any) {
    console.error('Error Instagram account-info:', err.message);
    res.status(500).json({ error: 'Error al obtener info de la cuenta', detail: err.message });
  }
};

// ── GET /api/instagram/debug ──────────────────────────────────────────────────
// TEMPORAL: público para diagnóstico.
export const debugAccount = async (_req: Request, res: Response) => {
  res.json({ message: 'Debug endpoint deshabilitado en modo multi-usuario' });
};

// ── POST /api/instagram/upload ────────────────────────────────────────────────
export const uploadToInstagram = async (req: AuthRequest, res: Response) => {
  const { fileId, caption = '', tags = [], thumbOffset, crossPostFacebook = false } = req.body;
  if (!fileId) return res.status(400).json({ error: 'fileId requerido' });

  const fileDoc = await FileModel.findOne({ _id: fileId, userId: req.user!.id }).lean();
  if (!fileDoc)                             return res.status(404).json({ error: 'Archivo no encontrado' });
  if (fileDoc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo fue eliminado del disco' });

  const filePath = fileDoc.file_path as string;
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Archivo físico no encontrado en disco' });

  const tokenData = await loadTokens(req.user!.id);
  if (!tokenData?.access_token || !tokenData?.instagram_user_id) {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
  }

  const { access_token } = tokenData;

  // El ID de /me es el único válido para la Graph API.
  const meRes  = await fetch(`${IG_GRAPH}/me?fields=user_id&access_token=${access_token}`);
  const meJson = await meRes.json() as any;
  const instagram_user_id: string = String(meJson.user_id ?? tokenData.instagram_user_id);
  if (meJson.user_id && String(meJson.user_id) !== String(tokenData.instagram_user_id)) {
    await saveTokens(req.user!.id, { access_token, instagram_user_id });
  }

  const hashtagLine = (tags as string[]).length
    ? '\n\n' + (tags as string[]).map(t => `#${t}`).join(' ')
    : '';
  const fullCaption = String(caption) + hashtagLine;

  const apiUrl = (process.env.API_URL || '').replace(/\/$/, '');
  if (!apiUrl.startsWith('https://')) {
    return res.status(500).json({ error: 'API_URL debe ser una URL pública https para que Meta descargue el video' });
  }
  const videoUrl = `${apiUrl}/api/videos/download/${fileId}`;

  try {
    const containerPayload: Record<string, any> = {
      media_type:    'REELS',
      video_url:     videoUrl,
      caption:       fullCaption,
      share_to_feed: true,
      access_token,
    };
    if (thumbOffset != null) containerPayload.thumb_offset = Math.round(Number(thumbOffset) * 1000);
    if (crossPostFacebook) containerPayload.cross_post_facebook_reels = true;

    const containerData = await igPost(`/${instagram_user_id}/media`, containerPayload);
    if (!containerData.id) throw new Error(containerData.error?.message ?? 'Error al crear contenedor de media');

    const containerId = containerData.id as string;

    let statusCode = 'IN_PROGRESS';
    for (let i = 0; i < 72 && statusCode === 'IN_PROGRESS'; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusData = await igGet(`/${containerId}?fields=status_code,status`, access_token);
      statusCode = (statusData.status_code as string | undefined) ?? 'IN_PROGRESS';
      if (statusCode === 'ERROR') {
        throw new Error((statusData.status as string | undefined) ?? 'Error procesando el video en Instagram');
      }
    }
    if (statusCode !== 'FINISHED') {
      throw new Error('Tiempo de espera agotado. El video sigue procesándose en Instagram.');
    }

    const publishData = await igPost(`/${instagram_user_id}/media_publish`, {
      creation_id: containerId,
      access_token,
    });
    if (!publishData.id) throw new Error(publishData.error?.message ?? 'Error al publicar');

    const mediaData = await igGet(`/${publishData.id}?fields=permalink`, access_token);
    const postUrl = (mediaData.permalink as string | undefined) ?? 'https://www.instagram.com/';

    await PlatformVideoModel.findOneAndUpdate(
      { platform: 'instagram', platformId: publishData.id },
      { platform: 'instagram', platformId: publishData.id, platformUrl: postUrl, publishedAt: new Date(), linkedFileId: fileId, matchStatus: 'manual' },
      { upsert: true },
    );

    const platformsToAdd = crossPostFacebook ? ['instagram', 'facebook'] : ['instagram'];
    await FileModel.findByIdAndUpdate(fileId, {
      $set: { content_status: 'publicado' },
      $addToSet: { platforms: { $each: platformsToAdd } },
    });

    res.json({ ok: true, mediaId: publishData.id, postUrl, crossPostedFacebook: !!crossPostFacebook });
  } catch (err: any) {
    console.error('Error al subir a Instagram:', err.message);
    res.status(500).json({ error: 'Error al subir a Instagram', detail: err.message });
  }
};
