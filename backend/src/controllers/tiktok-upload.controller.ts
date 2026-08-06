import { Request, Response } from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { applyPlatformPublish } from './backup.controller';
import { AuthRequest } from '../middleware/auth.middleware';
import { encodeState, decodeState } from '../utils/oauth-state';
import { recordAuditEvent } from '../services/audit.service';

const TK_BASE   = 'https://open.tiktokapis.com/v2';
const TK_AUTH   = 'https://www.tiktok.com/v2/auth/authorize/';
const TK_TOKEN  = `${TK_BASE}/oauth/token/`;
const TK_REVOKE = `${TK_BASE}/oauth/revoke/`;

const tkKey    = () => process.env.TIKTOK_CLIENT_KEY!;
const tkSecret = () => process.env.TIKTOK_CLIENT_SECRET!;

// ── Token storage per user ────────────────────────────────────────────────────
async function saveTokens(userId: string, data: object) {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').updateOne(
    { provider: 'tiktok', userId },
    { $set: { provider: 'tiktok', userId, ...data, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function loadTokens(userId: string): Promise<Record<string, any> | null> {
  const db = mongoose.connection.db!;
  const doc = await db.collection('oauth_tokens').findOne({ provider: 'tiktok', userId });
  return doc ?? null;
}

async function refreshAccessToken(refreshToken: string): Promise<Record<string, any>> {
  const res = await fetch(TK_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key:    tkKey(),
      client_secret: tkSecret(),
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error_description ?? data.error);
  return data;
}

export async function getValidToken(userId: string): Promise<{ access_token: string; open_id: string }> {
  const stored = await loadTokens(userId);
  if (!stored?.access_token) throw new Error('NO_AUTH');

  const updatedAt   = new Date(stored.updatedAt).getTime();
  const expiresAt   = updatedAt + (stored.expires_in ?? 86400) * 1000;
  const needsRefresh = Date.now() > expiresAt - 5 * 60 * 1000;

  if (needsRefresh && stored.refresh_token) {
    const fresh = await refreshAccessToken(stored.refresh_token);
    await saveTokens(userId, fresh);
    return { access_token: fresh.access_token, open_id: fresh.open_id ?? stored.open_id };
  }

  return { access_token: stored.access_token, open_id: stored.open_id };
}

// Popup que cierra y notifica al frontend — o deep link si es la app Android/iOS
// (no hay window.opener en una Custom Tab / ASWebAuthenticationSession, así que ahí no tiene sentido el HTML).
function popupResult(res: Response, status: string, origin = process.env.FRONTEND_URL || 'http://localhost:5173', client?: string) {
  if (client === 'android' || client === 'ios') {
    res.redirect(302, `essenalytics://oauth-callback?platform=tiktok&status=${encodeURIComponent(status)}`);
    return;
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;background:#0c0c14;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>Conectando con TikTok… puedes cerrar esta ventana.</p>
<script>(function(){
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ source: 'tiktok_auth', status: ${JSON.stringify(status)} }, '*');
      window.close();
      return;
    }
  } catch (e) {}
  window.location.replace(${JSON.stringify(origin)} + '/?tiktok_auth=' + ${JSON.stringify(status)});
})();</script>
</body></html>`);
}

// ── GET /api/tiktok/token — devuelve token válido al local-backend ────────────
export const getToken = async (req: AuthRequest, res: Response) => {
  try {
    const token = await getValidToken(req.user!.id);
    res.json(token); // { access_token, open_id }
  } catch {
    res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de TikTok primero' });
  }
};

// ── GET /api/tiktok/auth/url ──────────────────────────────────────────────────
export const getAuthUrl = (req: AuthRequest, res: Response) => {
  const origin = req.query.origin as string | undefined;
  const client = req.query.client as string | undefined;
  const installationId = req.query.installationId as string | undefined;
  const deviceName     = req.query.deviceName as string | undefined;
  const appVersion     = req.query.appVersion as string | undefined;
  const state = encodeState(req.user!.id, origin, client, { installationId, deviceName, appVersion });
  const params = new URLSearchParams({
    client_key:    tkKey(),
    scope:         'user.info.basic,video.publish,video.upload,video.list',
    response_type: 'code',
    redirect_uri:  process.env.TIKTOK_REDIRECT_URI!,
    state,
  });
  res.json({ url: `${TK_AUTH}?${params}` });
};

// ── GET /api/tiktok/auth/callback ─────────────────────────────────────────────
export const handleCallback = async (req: Request, res: Response) => {
  const code  = req.query.code  as string;
  const state = req.query.state as string;
  if (!code || !state) return popupResult(res, 'error');

  const { userId, origin, client, installationId, deviceName, appVersion } = decodeState(state);
  if (!userId) return popupResult(res, 'error', origin, client);

  try {
    const tokenRes = await fetch(TK_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key:    tkKey(),
        client_secret: tkSecret(),
        code,
        grant_type:    'authorization_code',
        redirect_uri:  process.env.TIKTOK_REDIRECT_URI!,
      }),
    });
    const data = await tokenRes.json() as any;
    if (data.error) throw new Error(data.error_description ?? data.error);

    await saveTokens(userId, data);
    await recordAuditEvent({
      userId, type: 'platform_connect', platform: 'tiktok',
      installationId, deviceName, source: client, appVersion,
    });
    popupResult(res, 'success', origin, client);
  } catch (err: any) {
    console.error('TikTok OAuth error:', err.message);
    popupResult(res, 'error', origin, client);
  }
};

// ── GET /api/tiktok/auth/status ───────────────────────────────────────────────
export const getAuthStatus = async (req: AuthRequest, res: Response) => {
  try {
    await getValidToken(req.user!.id);
    res.json({ connected: true });
  } catch {
    res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de TikTok nuevamente' });
  }
};

// ── DELETE /api/tiktok/auth ───────────────────────────────────────────────────
export const revokeAuth = async (req: AuthRequest, res: Response) => {
  const stored = await loadTokens(req.user!.id);
  if (stored?.access_token) {
    try {
      await fetch(TK_REVOKE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key:    tkKey(),
          client_secret: tkSecret(),
          token:         stored.access_token,
        }),
      });
    } catch (err: any) {
      console.error('Error al revocar token TikTok:', err.message);
    }
  }
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').deleteOne({ provider: 'tiktok', userId: req.user!.id });
  await recordAuditEvent({
    userId: req.user!.id, type: 'platform_disconnect', platform: 'tiktok',
    installationId: req.query.installationId as string | undefined,
    deviceName: req.query.deviceName as string | undefined,
    source: req.query.source as string | undefined,
    appVersion: req.query.appVersion as string | undefined,
  });
  res.json({ ok: true });
};

// ── GET /api/tiktok/creator-info ──────────────────────────────────────────────
export const getCreatorInfo = async (req: AuthRequest, res: Response) => {
  let token: { access_token: string; open_id: string };
  try {
    token = await getValidToken(req.user!.id);
  } catch {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de TikTok primero' });
  }

  try {
    const infoRes = await fetch(`${TK_BASE}/post/publish/creator_info/query/`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
    });
    const infoData = await infoRes.json() as any;
    if (infoData.error?.code !== 'ok') {
      throw new Error(infoData.error?.message ?? 'Error al obtener info del creador');
    }

    const d = infoData.data;
    res.json({
      nickname:            d.creator_nickname,
      avatarUrl:           d.creator_avatar_url,
      username:            d.creator_username,
      privacyOptions:      d.privacy_level_options,
      commentDisabled:     d.comment_disabled,
      duetDisabled:        d.duet_disabled,
      stitchDisabled:      d.stitch_disabled,
      maxVideoDurationSec: d.max_video_post_duration_sec,
    });
  } catch (err: any) {
    console.error('Error TikTok creator-info:', err.message);
    res.status(500).json({ error: 'Error al obtener info del creador', detail: err.message });
  }
};

// ── POST /api/tiktok/upload ───────────────────────────────────────────────────
export const uploadToTikTok = async (req: AuthRequest, res: Response) => {
  const {
    fileId, title = '', privacyLevel, thumbOffsetMs = 1000,
    disableDuet = false, disableComment = false, disableStitch = false,
    brandOrganic = false,
    brandedContent = false,
  } = req.body;
  if (!fileId) return res.status(400).json({ error: 'fileId requerido' });
  if (!privacyLevel) return res.status(400).json({ error: 'Debes seleccionar la privacidad del video' });
  if (brandedContent && privacyLevel === 'SELF_ONLY') {
    return res.status(400).json({ error: 'El contenido de marca (Branded Content) no puede tener visibilidad privada' });
  }

  const fileDoc = await FileModel.findOne({ _id: fileId, userId: req.user!.id }).lean();
  if (!fileDoc)                             return res.status(404).json({ error: 'Archivo no encontrado' });
  if (fileDoc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo fue eliminado del disco' });

  const filePath = fileDoc.file_path as string;
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Archivo físico no encontrado en disco' });

  let token: { access_token: string; open_id: string };
  try {
    token = await getValidToken(req.user!.id);
  } catch {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de TikTok primero' });
  }

  const apiUrl = (process.env.API_URL || '').replace(/\/$/, '');
  if (!apiUrl.startsWith('https://')) {
    return res.status(500).json({ error: 'API_URL debe ser una URL pública https para que TikTok descargue el video' });
  }
  // /api/videos/download ahora exige token (fix de ownership) y TikTok descarga esta
  // URL sin headers — se firma un JWT corto del mismo usuario y va en la query string
  // (verifyTokenFromHeaderOrQuery lo acepta). El chequeo de dueño sigue aplicando.
  const downloadToken = jwt.sign(
    { id: req.user!.id, username: req.user!.username, role: req.user!.role, tier: req.user!.tier },
    process.env.JWT_SECRET || 'esse_secret_key_2024',
    { expiresIn: '2h' },
  );
  const videoUrl = `${apiUrl}/api/videos/download/${fileId}?token=${downloadToken}`;
  console.log(`[TikTok] PULL_FROM_URL: ${apiUrl}/api/videos/download/${fileId}?token=<jwt>`);

  try {
    const initRes = await fetch(`${TK_BASE}/post/publish/video/init/`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title:                    String(title).slice(0, 2200),
          privacy_level:            privacyLevel,
          disable_duet:             Boolean(disableDuet),
          disable_comment:          Boolean(disableComment),
          disable_stitch:           Boolean(disableStitch),
          video_cover_timestamp_ms: Number(thumbOffsetMs),
          brand_content_toggle:     Boolean(brandedContent),
          brand_organic_toggle:     Boolean(brandOrganic),
        },
        source_info: {
          source:    'PULL_FROM_URL',
          video_url: videoUrl,
        },
      }),
    });
    const initData = await initRes.json() as any;
    console.log('[TikTok] init response:', JSON.stringify(initData));
    if (initData.error?.code !== 'ok') {
      throw new Error(initData.error?.message ?? 'Error al iniciar publicación en TikTok');
    }

    const { publish_id } = initData.data as { publish_id: string };

    let publishStatus = 'PROCESSING_UPLOAD';
    let realVideoId: string | null = null;
    for (let i = 0; i < 60 && !['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED'].includes(publishStatus); i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`${TK_BASE}/post/publish/status/fetch/`, {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${token.access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id }),
      });
      const statusText = await statusRes.text();
      const statusData = JSON.parse(statusText) as any;
      publishStatus    = statusData.data?.status ?? publishStatus;
      // ID real del video público (typo de TikTok: "publicaly", no "publicly").
      // publish_id es solo el id de la operación de publicar -- no sirve para
      // armar el link ni para pedir stats después vía /video/query/. Ojo: viene
      // como número JSON de 64 bits y JSON.parse le pierde los últimos dígitos
      // (pasa Number.MAX_SAFE_INTEGER) -- hay que sacarlo del texto crudo.
      const postIdMatch = statusText.match(/"publicaly_available_post_id"\s*:\s*\[\s*(\d+)/);
      if (postIdMatch) realVideoId = postIdMatch[1];
      if (publishStatus === 'FAILED') {
        throw new Error(`TikTok rechazó el video: ${statusData.data?.fail_reason ?? 'error desconocido'}`);
      }
    }

    if (!['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX'].includes(publishStatus)) {
      throw new Error('Tiempo de espera agotado. El video sigue procesándose en TikTok.');
    }

    // Sin publicaly_available_post_id (puede pasar con privacidad SELF_ONLY)
    // no hay forma de resolver el id real acá -- se cae a publish_id como
    // antes, sabiendo que el link/las métricas de ese video no van a andar.
    const videoIdForLink = realVideoId ?? publish_id;
    const platformUrl = `https://www.tiktok.com/@${token.open_id}/video/${videoIdForLink}`;
    await applyPlatformPublish(req.user!.id, {
      platform: 'tiktok', platformId: videoIdForLink, platformUrl, fileName: fileDoc.file_name, matchStatus: 'manual',
    });

    await FileModel.findByIdAndUpdate(fileId, {
      $set: { content_status: 'publicado' },
      $addToSet: { platforms: 'tiktok' },
    });

    res.json({
      ok:          true,
      publishId:   publish_id,
      status:      publishStatus,
      sentToInbox: publishStatus === 'SEND_TO_USER_INBOX',
    });
  } catch (err: any) {
    console.error('Error al subir a TikTok:', err.message);
    res.status(500).json({ error: 'Error al subir a TikTok', detail: err.message });
  }
};
