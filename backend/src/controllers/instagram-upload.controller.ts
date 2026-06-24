import { Request, Response } from 'express';
import fs from 'fs';
import https from 'https';
import http from 'http';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { PlatformVideoModel } from '../models/platform-video.model';

// Instagram Business Login usa graph.instagram.com, no graph.facebook.com
const IG_GRAPH  = 'https://graph.instagram.com/v22.0';
const IG_OAUTH  = 'https://api.instagram.com/oauth/access_token';
const IG_AUTH   = 'https://www.instagram.com/oauth/authorize';
const IG_LTOKEN = 'https://graph.instagram.com/access_token';

// ── Token storage ─────────────────────────────────────────────────────────────
async function saveTokens(data: object) {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').updateOne(
    { provider: 'instagram' },
    { $set: { provider: 'instagram', ...data, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function loadTokens(): Promise<Record<string, any> | null> {
  const db = mongoose.connection.db!;
  const doc = await db.collection('oauth_tokens').findOne({ provider: 'instagram' });
  return doc ?? null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function igGet(path: string, token: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${IG_GRAPH}${path}${sep}access_token=${token}`);
  return res.json();
}

// La Graph API de Meta espera los parámetros como form-urlencoded, no JSON.
// Con JSON, parámetros como upload_type=resumable se ignoran silenciosamente.
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
// Se leen dentro de las funciones para que dotenv ya esté cargado
const igAppId     = () => process.env.INSTAGRAM_APP_ID     || process.env.META_APP_ID!;
const igAppSecret = () => process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET!;

// Devuelve una página que avisa a la ventana padre y se cierra (o redirige si no es popup)
function popupResult(res: Response, status: string) {
  const origin = process.env.FRONTEND_URL || 'http://localhost:5173';
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

// ── GET /api/instagram/auth/url ───────────────────────────────────────────────
export const getAuthUrl = (_req: Request, res: Response) => {
  const params = new URLSearchParams({
    client_id:     igAppId(),
    redirect_uri:  process.env.META_REDIRECT_URI!,
    scope:         'instagram_business_basic,instagram_business_content_publish',
    response_type: 'code',
  });
  res.json({ url: `${IG_AUTH}?${params}` });
};

// ── GET /api/instagram/auth/callback ─────────────────────────────────────────
export const handleCallback = async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) return popupResult(res, 'error');

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
    // user_id is already returned here (Instagram-scoped ID)
    const igUserId: string   = String(tokenJson.user_id);

    // 2. Exchange for long-lived token (~60 days)
    const longRes = await fetch(
      `${IG_LTOKEN}?grant_type=ig_exchange_token&client_secret=${igAppSecret()}&access_token=${shortToken}`
    );
    const longJson = await longRes.json() as any;
    if (longJson.error) throw new Error(longJson.error.message ?? JSON.stringify(longJson.error));
    const longToken: string = longJson.access_token;

    // El user_id del intercambio de token NO sirve para la Graph API.
    // Hay que pedir el ID real de la cuenta profesional vía /me.
    const meRes  = await fetch(`${IG_GRAPH}/me?fields=user_id&access_token=${longToken}`);
    const meJson = await meRes.json() as any;
    const realUserId: string = String(meJson.user_id ?? igUserId);

    if (!realUserId) return popupResult(res, 'no_ig_account');

    await saveTokens({ access_token: longToken, instagram_user_id: realUserId });
    popupResult(res, 'success');
  } catch (err: any) {
    console.error('Instagram OAuth error:', err.message);
    popupResult(res, 'error');
  }
};

// ── GET /api/instagram/auth/status ───────────────────────────────────────────
export const getAuthStatus = async (_req: Request, res: Response) => {
  const tokens = await loadTokens();
  res.json({ connected: !!(tokens?.access_token && tokens?.instagram_user_id) });
};

// ── DELETE /api/instagram/auth ────────────────────────────────────────────────
export const revokeAuth = async (_req: Request, res: Response) => {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').deleteOne({ provider: 'instagram' });
  res.json({ ok: true });
};

// ── GET /api/instagram/account-info ───────────────────────────────────────────
export const getAccountInfo = async (_req: Request, res: Response) => {
  const tokens = await loadTokens();
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
// TEMPORAL: público para diagnóstico. Devuelve solo info no sensible.
export const debugAccount = async (_req: Request, res: Response) => {
  const tokens = await loadTokens();
  if (!tokens?.access_token) return res.json({ error: 'No token saved' });

  const { access_token, instagram_user_id } = tokens;

  // /me con el token — devuelve el user_id correcto para publicar
  const meRes  = await fetch(`${IG_GRAPH}/me?fields=user_id,username,account_type&access_token=${access_token}`);
  const me     = await meRes.json();

  // El ID que tenemos guardado
  const storedRes = await fetch(`${IG_GRAPH}/${instagram_user_id}?fields=id,username,account_type&access_token=${access_token}`);
  const stored    = await storedRes.json();

  res.json({
    stored_id: instagram_user_id,
    me,                       // lo que dice /me (user_id que SÍ sirve para publicar)
    storedLookup: stored,     // qué pasa al consultar el id guardado
    ids_match: String(me.user_id) === String(instagram_user_id),
  });
};

// ── POST /api/instagram/upload ────────────────────────────────────────────────
export const uploadToInstagram = async (req: Request, res: Response) => {
  const { fileId, caption = '', tags = [], thumbOffset } = req.body;
  if (!fileId) return res.status(400).json({ error: 'fileId requerido' });

  const fileDoc = await FileModel.findById(fileId).lean();
  if (!fileDoc)                             return res.status(404).json({ error: 'Archivo no encontrado' });
  if (fileDoc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo fue eliminado del disco' });

  const filePath = fileDoc.file_path as string;
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Archivo físico no encontrado en disco' });

  const tokenData = await loadTokens();
  if (!tokenData?.access_token || !tokenData?.instagram_user_id) {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
  }

  const { access_token } = tokenData;

  // El ID de /me es el único válido para la Graph API. Lo resolvemos siempre
  // (el user_id del intercambio de token del OAuth no sirve aquí).
  const meRes  = await fetch(`${IG_GRAPH}/me?fields=user_id&access_token=${access_token}`);
  const meJson = await meRes.json() as any;
  const instagram_user_id: string = String(meJson.user_id ?? tokenData.instagram_user_id);
  if (meJson.user_id && String(meJson.user_id) !== String(tokenData.instagram_user_id)) {
    await saveTokens({ access_token, instagram_user_id }); // auto-corrige el guardado
  }

  const hashtagLine = (tags as string[]).length
    ? '\n\n' + (tags as string[]).map(t => `#${t}`).join(' ')
    : '';
  const fullCaption = String(caption) + hashtagLine;

  // URL pública desde la que Meta descargará el video (vía el túnel de Cloudflare)
  const apiUrl   = (process.env.API_URL || '').replace(/\/$/, '');
  if (!apiUrl.startsWith('https://')) {
    return res.status(500).json({ error: 'API_URL debe ser una URL pública https para que Meta descargue el video' });
  }
  const videoUrl = `${apiUrl}/api/videos/download/${fileId}`;

  try {
    // Step 1: Create media container (Meta descarga el video desde video_url)
    const containerPayload: Record<string, any> = {
      media_type:    'REELS',
      video_url:     videoUrl,
      caption:       fullCaption,
      share_to_feed: true,
      access_token,
    };
    if (thumbOffset != null) containerPayload.thumb_offset = Math.round(Number(thumbOffset) * 1000);

    const containerData = await igPost(`/${instagram_user_id}/media`, containerPayload);
    if (!containerData.id) throw new Error(containerData.error?.message ?? 'Error al crear contenedor de media');

    const containerId = containerData.id as string;

    // Step 2: Poll until FINISHED (Meta descarga y procesa; máx ~5 min, cada 5 s)
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

    // Step 4: Publish
    const publishData = await igPost(`/${instagram_user_id}/media_publish`, {
      creation_id: containerId,
      access_token,
    });
    if (!publishData.id) throw new Error(publishData.error?.message ?? 'Error al publicar');

    // Get permalink
    const mediaData = await igGet(`/${publishData.id}?fields=permalink`, access_token);
    const postUrl = (mediaData.permalink as string | undefined) ?? 'https://www.instagram.com/';

    await PlatformVideoModel.findOneAndUpdate(
      { platform: 'instagram', platformId: publishData.id },
      { platform: 'instagram', platformId: publishData.id, platformUrl: postUrl, publishedAt: new Date(), linkedFileId: fileId, matchStatus: 'manual' },
      { upsert: true },
    );

    res.json({
      ok:      true,
      mediaId: publishData.id,
      postUrl,
    });
  } catch (err: any) {
    console.error('Error al subir a Instagram:', err.message);
    res.status(500).json({ error: 'Error al subir a Instagram', detail: err.message });
  }
};
