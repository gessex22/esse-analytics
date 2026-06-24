import { Request, Response } from 'express';
import fs from 'fs';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { PlatformVideoModel } from '../models/platform-video.model';

const TK_BASE   = 'https://open.tiktokapis.com/v2';
const TK_AUTH   = 'https://www.tiktok.com/v2/auth/authorize/';
const TK_TOKEN  = `${TK_BASE}/oauth/token/`;
const TK_REVOKE = `${TK_BASE}/oauth/revoke/`;

const tkKey    = () => process.env.TIKTOK_CLIENT_KEY!;
const tkSecret = () => process.env.TIKTOK_CLIENT_SECRET!;

// ── Token storage ─────────────────────────────────────────────────────────────
async function saveTokens(data: object) {
  const db = mongoose.connection.db!;
  await db.collection('oauth_tokens').updateOne(
    { provider: 'tiktok' },
    { $set: { provider: 'tiktok', ...data, updatedAt: new Date() } },
    { upsert: true },
  );
}

async function loadTokens(): Promise<Record<string, any> | null> {
  const db = mongoose.connection.db!;
  const doc = await db.collection('oauth_tokens').findOne({ provider: 'tiktok' });
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

async function getValidToken(): Promise<{ access_token: string; open_id: string }> {
  const stored = await loadTokens();
  if (!stored?.access_token) throw new Error('NO_AUTH');

  // Refresh si quedan menos de 5 minutos (expires_in en segundos desde updatedAt)
  const updatedAt   = new Date(stored.updatedAt).getTime();
  const expiresAt   = updatedAt + (stored.expires_in ?? 86400) * 1000;
  const needsRefresh = Date.now() > expiresAt - 5 * 60 * 1000;

  if (needsRefresh && stored.refresh_token) {
    const fresh = await refreshAccessToken(stored.refresh_token);
    await saveTokens(fresh);
    return { access_token: fresh.access_token, open_id: fresh.open_id ?? stored.open_id };
  }

  return { access_token: stored.access_token, open_id: stored.open_id };
}

// Popup que cierra y notifica al frontend (igual que Instagram)
function popupResult(res: Response, status: string) {
  const origin = process.env.FRONTEND_URL || 'http://localhost:5173';
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

// ── GET /api/tiktok/auth/url ──────────────────────────────────────────────────
export const getAuthUrl = (_req: Request, res: Response) => {
  const params = new URLSearchParams({
    client_key:    tkKey(),
    scope:         'user.info.basic,video.publish,video.upload',
    response_type: 'code',
    redirect_uri:  process.env.TIKTOK_REDIRECT_URI!,
    state:         Math.random().toString(36).slice(2),
  });
  res.json({ url: `${TK_AUTH}?${params}` });
};

// ── GET /api/tiktok/auth/callback ─────────────────────────────────────────────
export const handleCallback = async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) return popupResult(res, 'error');

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

    await saveTokens(data);
    popupResult(res, 'success');
  } catch (err: any) {
    console.error('TikTok OAuth error:', err.message);
    popupResult(res, 'error');
  }
};

// ── GET /api/tiktok/auth/status ───────────────────────────────────────────────
export const getAuthStatus = async (_req: Request, res: Response) => {
  const tokens = await loadTokens();
  res.json({ connected: !!tokens?.access_token });
};

// ── DELETE /api/tiktok/auth ───────────────────────────────────────────────────
export const revokeAuth = async (_req: Request, res: Response) => {
  // Revoca el permiso del lado de TikTok (no solo borra nuestro token).
  const stored = await loadTokens();
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
  await db.collection('oauth_tokens').deleteOne({ provider: 'tiktok' });
  res.json({ ok: true });
};

// ── GET /api/tiktok/creator-info ──────────────────────────────────────────────
// Requerido por las guidelines: la UI debe traer info fresca del creador antes
// de mostrar el formulario (nickname, opciones de privacidad, límites, duración).
export const getCreatorInfo = async (_req: Request, res: Response) => {
  let token: { access_token: string; open_id: string };
  try {
    token = await getValidToken();
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
      nickname:                d.creator_nickname,
      avatarUrl:               d.creator_avatar_url,
      username:                d.creator_username,
      privacyOptions:          d.privacy_level_options,          // array de privacidades permitidas
      commentDisabled:         d.comment_disabled,
      duetDisabled:            d.duet_disabled,
      stitchDisabled:          d.stitch_disabled,
      maxVideoDurationSec:     d.max_video_post_duration_sec,
    });
  } catch (err: any) {
    console.error('Error TikTok creator-info:', err.message);
    res.status(500).json({ error: 'Error al obtener info del creador', detail: err.message });
  }
};

// ── POST /api/tiktok/upload ───────────────────────────────────────────────────
export const uploadToTikTok = async (req: Request, res: Response) => {
  const {
    fileId, title = '', privacyLevel, thumbOffsetMs = 1000,
    disableDuet = false, disableComment = false, disableStitch = false,
    // Commercial content disclosure
    brandOrganic = false,   // "Your Brand" — promociona marca propia
    brandedContent = false, // "Branded Content" — promociona a un tercero
  } = req.body;
  if (!fileId) return res.status(400).json({ error: 'fileId requerido' });
  if (!privacyLevel) return res.status(400).json({ error: 'Debes seleccionar la privacidad del video' });
  // Branded content no puede ser privado
  if (brandedContent && privacyLevel === 'SELF_ONLY') {
    return res.status(400).json({ error: 'El contenido de marca (Branded Content) no puede tener visibilidad privada' });
  }

  const fileDoc = await FileModel.findById(fileId).lean();
  if (!fileDoc)                             return res.status(404).json({ error: 'Archivo no encontrado' });
  if (fileDoc.status === 'ELIMINADO_DISCO') return res.status(400).json({ error: 'El archivo fue eliminado del disco' });

  const filePath = fileDoc.file_path as string;
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Archivo físico no encontrado en disco' });

  let token: { access_token: string; open_id: string };
  try {
    token = await getValidToken();
  } catch {
    return res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de TikTok primero' });
  }

  // PULL_FROM_URL: TikTok descarga el video desde una URL pública nuestra.
  // Es el método recomendado cuando el video ya está en el servidor (evita el
  // chunking de FILE_UPLOAD). Requiere dominio verificado en el portal de TikTok.
  const apiUrl = (process.env.API_URL || '').replace(/\/$/, '');
  if (!apiUrl.startsWith('https://')) {
    return res.status(500).json({ error: 'API_URL debe ser una URL pública https para que TikTok descargue el video' });
  }
  const videoUrl = `${apiUrl}/api/videos/download/${fileId}`;

  console.log(`[TikTok] PULL_FROM_URL: ${videoUrl}`);

  try {
    // Step 1: Init (PULL_FROM_URL)
    const initRes  = await fetch(`${TK_BASE}/post/publish/video/init/`, {
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
          // Commercial content disclosure
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

    // Step 2: Poll status (TikTok descarga y procesa; máx ~5 min, cada 5 s)
    let publishStatus = 'PROCESSING_UPLOAD';
    for (let i = 0; i < 60 && !['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED'].includes(publishStatus); i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes  = await fetch(`${TK_BASE}/post/publish/status/fetch/`, {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${token.access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id }),
      });
      const statusData = await statusRes.json() as any;
      publishStatus    = statusData.data?.status ?? publishStatus;
      if (publishStatus === 'FAILED') {
        throw new Error(`TikTok rechazó el video: ${statusData.data?.fail_reason ?? 'error desconocido'}`);
      }
    }

    if (!['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX'].includes(publishStatus)) {
      throw new Error('Tiempo de espera agotado. El video sigue procesándose en TikTok.');
    }

    // Step 4: Guardar en platformvideos
    const platformUrl = `https://www.tiktok.com/@${token.open_id}/video/${publish_id}`;
    await PlatformVideoModel.findOneAndUpdate(
      { platform: 'tiktok', platformId: publish_id },
      { platform: 'tiktok', platformId: publish_id, platformUrl, publishedAt: new Date(), linkedFileId: fileId, matchStatus: 'manual' },
      { upsert: true },
    );

    // Marca el archivo como publicado y registra la plataforma
    await FileModel.findByIdAndUpdate(fileId, {
      $set: { content_status: 'publicado' },
      $addToSet: { platforms: 'tiktok' },
    });

    res.json({
      ok:         true,
      publishId:  publish_id,
      status:     publishStatus,
      sentToInbox: publishStatus === 'SEND_TO_USER_INBOX',
    });
  } catch (err: any) {
    console.error('Error al subir a TikTok:', err.message);
    res.status(500).json({ error: 'Error al subir a TikTok', detail: err.message });
  }
};
