import { Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import http from 'http';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { PlatformVideoModel } from '../models/platform-video.model';
import { UploadHistoryModel } from '../models/upload-history.model';
import { applyPlatformPublish } from './backup.controller';
import { AuthRequest } from '../middleware/auth.middleware';
import { encodeState, decodeState } from '../utils/oauth-state';
import { recordAuditEvent } from '../services/audit.service';
import { env } from '../config/env';
import { errorName, logger } from '../utils/logger';

// Facebook Login for Business: el Page Access Token (de una Página de Facebook
// con una Cuenta de Instagram Business vinculada) sí soporta upload_type:
// resumable para Reels — Instagram Login (graph.instagram.com) solo soporta
// video_url, que exige exponer el video en una URL pública.
const FB_GRAPH        = 'https://graph.facebook.com/v22.0';
const FB_OAUTH_DIALOG = 'https://www.facebook.com/v22.0/dialog/oauth';
const FB_TOKEN        = 'https://graph.facebook.com/v22.0/oauth/access_token';

// ── Token storage per user ────────────────────────────────────────────────────
async function saveTokens(userId: string, data: object) {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').updateOne(
    { provider: 'instagram', userId },
    { $set: { provider: 'instagram', userId, ...data, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function loadTokens(userId: string): Promise<Record<string, any> | null> {
  const db = mongoose.connection.db!;
  const doc = await db.collection('oauth_tokens').findOne({ provider: 'instagram', userId });
  return doc ?? null;
}

function decodeMetaSignedRequest(value: string): { user_id?: string } | null {
  const [encodedSignature, encodedPayload] = value.split('.', 2);
  if (!encodedSignature || !encodedPayload) return null;
  const decodeBase64Url = (input: string) => Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const signature = decodeBase64Url(encodedSignature);
  const expected = crypto.createHmac('sha256', fbAppSecret()).update(encodedPayload).digest();
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;
  try { return JSON.parse(decodeBase64Url(encodedPayload).toString('utf8')); } catch { return null; }
}

// POST /api/instagram/data-deletion — callback público configurado en Meta.
export const handleDataDeletion = async (req: Request, res: Response): Promise<void> => {
  const signedRequest = typeof req.body?.signed_request === 'string' ? req.body.signed_request : '';
  const payload = decodeMetaSignedRequest(signedRequest);
  if (!payload?.user_id) { res.status(400).json({ error: 'Invalid signed_request' }); return; }

  const db = mongoose.connection.db!;
  const tokenDoc = await db.collection('oauth_tokens').findOne({ provider: 'instagram', meta_user_id: payload.user_id });
  const appUserId = tokenDoc?.userId ? String(tokenDoc.userId) : null;
  if (appUserId) {
    await db.collection('oauth_tokens').deleteOne({ provider: 'instagram', userId: appUserId });
    await PlatformVideoModel.deleteMany({ userId: appUserId, platform: 'instagram' });
    await UploadHistoryModel.deleteMany({ userId: appUserId, platform: 'instagram' });
  }

  res.json({
    url: `${env.FRONTEND_URL}/data-deletion/`,
    confirmation_code: crypto.randomBytes(16).toString('hex'),
  });
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function igGet(path: string, token: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FB_GRAPH}${path}${sep}access_token=${token}`);
  return res.json();
}

// La Graph API de Meta espera los parámetros como form-urlencoded, no JSON.
async function igPost(path: string, body: Record<string, any>): Promise<any> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`${FB_GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return res.json();
}

// Sube un archivo local al endpoint de Resumable Upload de Meta.
// OJO: hay que mandar el archivo COMPLETO como buffer (req.end(buffer)). Si se manda
// como stream (pipe), Meta lo rechaza con ProcessingFailedError "Request processing
// failed" — confirmado probando ambas formas contra rupload.facebook.com.
function streamFileToMeta(uri: string, token: string, filePath: string, _fileSize: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(uri);
    const mod = url.protocol === 'https:' ? https : http;
    const buffer = fs.readFileSync(filePath);

    const req = mod.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        Authorization:    `OAuth ${token}`,
        offset:           '0',
        file_size:        String(buffer.length),
        'Content-Type':   'application/octet-stream',
        'Content-Length': String(buffer.length),
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
    req.end(buffer);
  });
}

// Publica el MISMO archivo como Reel en la Página de Facebook vía la Reels
// Publishing API (/{page_id}/video_reels). Es el crossposting robusto: el flag
// cross_post_facebook_reels del contenedor de IG no está documentado y Meta lo
// ignora en silencio, y el "Compartir a Facebook" manual desde la app de IG
// falla con "no se puede reusar el audio" en reels subidos por API (el audio
// queda registrado como audio original de ese reel). Publicar directo en la
// Página evita ambos problemas. Requiere el scope pages_manage_posts.
export async function publishReelToFacebookPage(
  filePath: string,
  pageId: string,
  pageToken: string,
  description: string,
): Promise<{ videoId: string; url: string }> {
  // 1. Iniciar sesión de subida → video_id + upload_url (rupload.facebook.com)
  const start = await igPost(`/${pageId}/video_reels`, { upload_phase: 'start', access_token: pageToken });
  if (!start.video_id || !start.upload_url) {
    throw new Error(start.error?.message ?? `No se pudo iniciar la subida a Facebook [${JSON.stringify(start)}]`);
  }

  // 2. Subir los bytes — mismo protocolo (OAuth + offset + file_size) que el
  //    resumable upload de Instagram, así que se reusa el helper tal cual.
  await streamFileToMeta(start.upload_url, pageToken, filePath, 0);

  // 3. Publicar
  const finish = await igPost(`/${pageId}/video_reels`, {
    upload_phase: 'finish',
    video_id:     start.video_id,
    video_state:  'PUBLISHED',
    description,
    access_token: pageToken,
  });
  if (finish.error) throw new Error(finish.error.message ?? 'Error al publicar el Reel en Facebook');

  // 4. Esperar (acotado) a que Meta termine de procesar/publicar. Si no llega a
  //    ready en ese tiempo igual devolvemos éxito — el video ya quedó encolado
  //    del lado de Meta y termina de publicarse solo.
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await igGet(`/${start.video_id}?fields=status`, pageToken);
    const phase = st.status?.publishing_phase?.status ?? st.status?.video_status;
    if (st.status?.video_status === 'error') {
      throw new Error(`Facebook rechazó el video [${JSON.stringify(st.status)}]`);
    }
    if (phase === 'complete' || st.status?.video_status === 'ready') break;
  }

  return { videoId: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}` };
}

// Facebook Login for Business es un permiso de la Meta App principal, no una
// app separada — usa las mismas credenciales que el resto de la integración.
const fbAppId     = () => env.META_APP_ID;
const fbAppSecret = () => env.META_APP_SECRET;

// Devuelve una página que avisa a la ventana padre y se cierra (o redirige si no es popup).
// Si `client` es "android"/"ios", en vez de la página HTML (pensada para popup de
// navegador — no hay window.opener en una Custom Tab / ASWebAuthenticationSession)
// redirige directo a un deep link que la app registra, sin necesidad de polling.
function popupResult(res: Response, status: string, origin = env.FRONTEND_URL, client?: string) {
  if (client === 'android' || client === 'ios') {
    res.redirect(302, `essenalytics://oauth-callback?platform=instagram&status=${encodeURIComponent(status)}`);
    return;
  }
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

// Un doc de oauth_tokens sin authType es de antes de la migración a Facebook
// Login for Business (Instagram User Token, no Page Access Token) — no sirve
// contra graph.facebook.com. Se trata como "no conectado" para que el usuario
// reconecte por el flujo normal en vez de fallar con un error críptico de Meta.
export function isUsableInstagramConnection(tokens: Record<string, any> | null): boolean {
  return !!(tokens?.access_token && tokens?.instagram_user_id && tokens?.authType === 'facebook_login_business');
}

// ── GET /api/instagram/token — devuelve token válido al local-backend ─────────
export const getToken = async (req: AuthRequest, res: Response) => {
  const tokens = await loadTokens(req.user!.id);
  if (!isUsableInstagramConnection(tokens)) {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
  }
  // page_id: lo necesita el local-backend para publicar el Reel también en la
  // Página de Facebook (crossposting robusto vía /video_reels, no el flag
  // cross_post_facebook_reels que Meta ignora silenciosamente).
  res.json({ access_token: tokens!.access_token, instagram_user_id: tokens!.instagram_user_id, page_id: tokens!.page_id ?? null });
};

// ── GET /api/instagram/auth/url ───────────────────────────────────────────────
export const getAuthUrl = async (req: AuthRequest, res: Response) => {
  const origin = req.query.origin as string | undefined;
  const client = req.query.client as string | undefined;
  const installationId = req.query.installationId as string | undefined;
  const deviceName     = req.query.deviceName as string | undefined;
  const appVersion     = req.query.appVersion as string | undefined;
  const state = await encodeState(req.user!.id, origin, client, { installationId, deviceName, appVersion });
  const configId = env.META_LOGIN_CONFIG_ID;
  const params = new URLSearchParams({
    client_id:     fbAppId(),
    redirect_uri:  env.META_REDIRECT_URI,
    response_type: 'code',
    state,
  });
  if (configId) {
    // Facebook Login for Business: los permisos vienen de la Login
    // Configuration (config_id), no se listan por scope en la URL.
    params.set('config_id', configId);
  } else {
    // Fallback si todavía no se creó la Login Configuration en el dashboard.
    // instagram_manage_insights es lo que habilita /insights?metric=views (sin
    // él, Meta devuelve error de permisos y las vistas quedan en "--" en la UI).
    // pages_manage_posts habilita publicar Reels directo en la Página de
    // Facebook (/video_reels) — el crossposting robusto depende de él.
    params.set('scope', 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,instagram_manage_insights,business_management');
  }
  res.json({ url: `${FB_OAUTH_DIALOG}?${params}` });
};

// ── GET /api/instagram/auth/callback ─────────────────────────────────────────
export const handleCallback = async (req: Request, res: Response) => {
  const code  = req.query.code  as string;
  const state = req.query.state as string;
  console.log('[Instagram] Callback recibido, code:', !!code, 'state:', !!state);
  if (!state) return popupResult(res, 'error');

  let decoded;
  try {
    decoded = await decodeState(state);
  } catch {
    return popupResult(res, 'error');
  }
  const { userId, origin, client, installationId, deviceName, appVersion } = decoded;
  if (!userId) return popupResult(res, 'error', origin, client);
  if (!code) return popupResult(res, 'error', origin, client);

  try {
    // 1. Exchange code → short-lived User Access Token
    const shortRes = await fetch(
      `${FB_TOKEN}?client_id=${fbAppId()}&client_secret=${fbAppSecret()}&redirect_uri=${encodeURIComponent(env.META_REDIRECT_URI)}&code=${code}`
    );
    const shortJson = await shortRes.json() as any;
    if (shortJson.error) throw new Error(shortJson.error.message ?? JSON.stringify(shortJson.error));
    const shortToken: string = shortJson.access_token;

    // 2. Exchange for long-lived User Access Token (~60 días)
    const longRes = await fetch(
      `${FB_TOKEN}?grant_type=fb_exchange_token&client_id=${fbAppId()}&client_secret=${fbAppSecret()}&fb_exchange_token=${shortToken}`
    );
    const longJson = await longRes.json() as any;
    if (longJson.error) throw new Error(longJson.error.message ?? JSON.stringify(longJson.error));
    const longUserToken: string = longJson.access_token;

    const metaUserRes = await fetch(`${FB_GRAPH}/me?fields=id&access_token=${longUserToken}`);
    const metaUserJson = await metaUserRes.json() as any;
    const metaUserId = metaUserJson.id as string | undefined;

    // Diagnóstico: qué permisos quedaron realmente otorgados en el token.
    const permsRes  = await fetch(`${FB_GRAPH}/me/permissions?access_token=${longUserToken}`);
    const permsJson = await permsRes.json() as any;
    const granted = (permsJson.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
    const declined = (permsJson.data ?? []).filter((p: any) => p.status === 'declined').map((p: any) => p.permission);
    console.log(`[Instagram] Permisos otorgados: [${granted.join(', ')}] — rechazados: [${declined.join(', ')}]`);

    // 3. Páginas de Facebook que administra — cada una trae su propio Page
    // Access Token (ya de vida larga al derivar de un User Token largo).
    // limit=200 evita perder páginas si administra más de las 25 por default.
    const pagesRes  = await fetch(`${FB_GRAPH}/me/accounts?limit=200&access_token=${longUserToken}`);
    const pagesJson = await pagesRes.json() as any;
    if (pagesJson.error) throw new Error(pagesJson.error.message ?? JSON.stringify(pagesJson.error));
    const pages: Array<{ id: string; name: string; access_token: string }> = pagesJson.data ?? [];
    console.log(`[Instagram] Páginas de Facebook encontradas: ${pages.length}${pages.length ? ' (' + pages.map(p => p.name).join(', ') + ')' : ''}`);
    if (!pages.length) return popupResult(res, 'no_ig_account', origin, client);

    // 4. Primera Página con una Cuenta de Instagram Business vinculada.
    let pageId = '';
    let pageAccessToken = '';
    let igBusinessAccountId = '';
    for (const page of pages) {
      const linkRes  = await fetch(`${FB_GRAPH}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
      const linkJson = await linkRes.json() as any;
      if (linkJson.error) logger.warn('instagram_business_account_lookup_failed', {
        providerCode: linkJson.error?.code ?? null,
      });
      if (linkJson.instagram_business_account?.id) {
        pageId = page.id;
        pageAccessToken = page.access_token;
        igBusinessAccountId = linkJson.instagram_business_account.id;
        console.log(`[Instagram] Página vinculada: ${page.name} (${page.id}) → IG ${igBusinessAccountId}`);
        break;
      } else {
        console.log(`[Instagram] Página "${page.name}" (${page.id}) sin Cuenta de Instagram Business vinculada`);
      }
    }
    if (!igBusinessAccountId) return popupResult(res, 'no_ig_account', origin, client);

    await saveTokens(userId, {
      access_token:      pageAccessToken,
      instagram_user_id: igBusinessAccountId,
      page_id:           pageId,
      meta_user_id:      metaUserId,
      authType:          'facebook_login_business',
    });
    await recordAuditEvent({
      userId, type: 'platform_connect', platform: 'instagram',
      installationId, deviceName, source: client, appVersion,
    });
    popupResult(res, 'success', origin, client);
  } catch (err: any) {
    logger.error('instagram_oauth_callback_failed', { errorName: errorName(err) });
    popupResult(res, 'error', origin, client);
  }
};

// ── GET /api/instagram/auth/status ───────────────────────────────────────────
export const getAuthStatus = async (req: AuthRequest, res: Response) => {
  const tokens = await loadTokens(req.user!.id);
  if (!isUsableInstagramConnection(tokens)) return res.json({ connected: false });
  try {
    const account = await igGet(`/${tokens!.instagram_user_id}?fields=id`, tokens!.access_token);
    if (account?.error) throw new Error(account.error.message ?? 'invalid_token');
    res.json({ connected: true });
  } catch {
    res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram nuevamente' });
  }
};

// ── DELETE /api/instagram/auth ────────────────────────────────────────────────
export const revokeAuth = async (req: AuthRequest, res: Response) => {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').deleteOne({ provider: 'instagram', userId: req.user!.id });
  await recordAuditEvent({
    userId: req.user!.id, type: 'platform_disconnect', platform: 'instagram',
    installationId: req.query.installationId as string | undefined,
    deviceName: req.query.deviceName as string | undefined,
    source: req.query.source as string | undefined,
    appVersion: req.query.appVersion as string | undefined,
  });
  res.json({ ok: true });
};

// ── GET /api/instagram/account-info ───────────────────────────────────────────
export const getAccountInfo = async (req: AuthRequest, res: Response) => {
  const tokens = await loadTokens(req.user!.id);
  if (!isUsableInstagramConnection(tokens)) {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
  }
  try {
    // Un Page Access Token no tiene un /me útil para esto — se consulta
    // directo el nodo de la Cuenta de Instagram Business.
    const data = await igGet(`/${tokens!.instagram_user_id}?fields=username,name,profile_picture_url`, tokens!.access_token);
    if (data.error) throw new Error(data.error.message ?? 'Error al obtener la cuenta');
    res.json({
      name:      data.name ?? data.username ?? '',
      username:  data.username ?? '',
      avatarUrl: data.profile_picture_url ?? '',
    });
  } catch (err: any) {
    logger.warn('instagram_account_info_failed', { errorName: errorName(err) });
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
  if (!isUsableInstagramConnection(tokenData)) {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
  }

  const { access_token, instagram_user_id, page_id } = tokenData!;

  const hashtagLine = (tags as string[]).length
    ? '\n\n' + (tags as string[]).map(t => `#${t}`).join(' ')
    : '';
  const fullCaption = String(caption) + hashtagLine;
  const fileSize = fs.statSync(filePath).size;

  try {
    // upload_type resumable: se sube el archivo directo a Meta (streamFileToMeta), igual
    // que el local-backend. El flujo viejo con video_url dependía de que Meta descargara
    // /api/videos/download/:id públicamente — esa ruta ahora exige token (fix de
    // ownership), así que Meta recibía 401 y la subida fallaba.
    const containerPayload: Record<string, any> = {
      media_type:    'REELS',
      upload_type:   'resumable',
      caption:       fullCaption,
      share_to_feed: true,
      access_token,
    };
    if (thumbOffset != null) containerPayload.thumb_offset = Math.round(Number(thumbOffset) * 1000);
    // El crossposting a Facebook NO va acá (cross_post_facebook_reels no existe
    // en la API y Meta lo ignoraba en silencio) — se publica aparte en la Página
    // vía publishReelToFacebookPage() después de que IG confirme.

    const containerData = await igPost(`/${instagram_user_id}/media`, containerPayload);
    if (!containerData.id) {
      logger.error('instagram_container_create_failed', {
        providerCode: containerData.error?.code ?? null,
      });
      const metaError = containerData.error ?? containerData;
      throw new Error(
        (metaError.error_user_msg || metaError.message || 'Error al crear contenedor de media') +
        ` [raw: ${JSON.stringify(metaError)}]`
      );
    }

    const containerId = containerData.id as string;
    const uploadUri   = containerData.uri as string;
    if (!uploadUri) throw new Error('No se obtuvo upload URI de Instagram');

    await streamFileToMeta(uploadUri, access_token, filePath, fileSize);

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

    await applyPlatformPublish(req.user!.id, {
      platform: 'instagram', platformId: publishData.id, platformUrl: postUrl, fileName: fileDoc.file_name, matchStatus: 'manual',
    });

    // Crossposting robusto: el mismo archivo se publica como Reel en la Página
    // de Facebook. No-fatal: si falla, la subida a IG ya está hecha y se
    // reporta el detalle para que el usuario sepa que Facebook NO salió.
    let facebookUrl: string | null = null;
    let facebookError: string | null = null;
    if (crossPostFacebook) {
      if (!page_id) {
        facebookError = 'La conexión no tiene una Página de Facebook asociada — reconectá Instagram.';
      } else {
        try {
          const fb = await publishReelToFacebookPage(filePath, page_id, access_token, fullCaption);
          facebookUrl = fb.url;
          await applyPlatformPublish(req.user!.id, {
            platform: 'facebook', platformId: fb.videoId, platformUrl: fb.url, fileName: fileDoc.file_name, matchStatus: 'manual',
          });
        } catch (err: any) {
          facebookError = err.message;
          logger.warn('facebook_crosspost_failed', { errorName: errorName(err) });
        }
      }
    }

    const platformsToAdd = facebookUrl ? ['instagram', 'facebook'] : ['instagram'];
    await FileModel.findByIdAndUpdate(fileId, {
      $set: { content_status: 'publicado' },
      $addToSet: { platforms: { $each: platformsToAdd } },
    });

    res.json({ ok: true, mediaId: publishData.id, postUrl, crossPostedFacebook: !!facebookUrl, facebookUrl, facebookError });
  } catch (err: any) {
    logger.error('instagram_upload_failed', { errorName: errorName(err) });
    res.status(500).json({ error: 'Error al subir a Instagram', detail: err.message });
  }
};
