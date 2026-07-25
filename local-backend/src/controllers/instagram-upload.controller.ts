import { Request, Response } from 'express';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { fileRepo } from '../db/file.repo';
import { platformVideoRepo } from '../db/platform-video.repo';
import { configRepo } from '../db/config.repo';
import { pushFilesToCloudInBackground } from './backup-sync.controller';
import { normalizeForMeta, trimToMaxDuration, appendDebugLog } from '../services/video-normalize.service';
import { syncNextVideoToCentral } from '../services/calendar-sync.service';
import { reportUploadEvent } from '../services/upload-history.service';
import { setUploadProgress, clearUploadProgress, setUploadError } from '../state/upload-activity';

// Facebook Login for Business: central entrega un Page Access Token (de una
// Página con una Cuenta de Instagram Business vinculada), válido contra
// graph.facebook.com y compatible con upload_type: resumable para Reels.
const FB_GRAPH = 'https://graph.facebook.com/v22.0';
const CENTRAL  = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

export type UploadStage = 'original' | 'recorte-60s' | 'recorte-60s+normalizado';

async function fetchToken(authHeader: string): Promise<{ access_token: string; instagram_user_id: string; page_id?: string | null }> {
  const res = await fetch(`${CENTRAL}/api/instagram/token`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    throw new Error('NO_AUTH');
  }
  return res.json() as Promise<{ access_token: string; instagram_user_id: string; page_id?: string | null }>;
}

async function igGet(path: string, token: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FB_GRAPH}${path}${sep}access_token=${token}`);
  return res.json();
}

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

// Sube el archivo directamente a Meta (sin URL pública — upload resumable desde local).
// OJO: hay que mandar el archivo COMPLETO como buffer (req.end(buffer)). Si se manda
// como stream (pipe), Meta lo rechaza con ProcessingFailedError "Request processing
// failed" — confirmado probando ambas formas contra rupload.facebook.com.
function streamFileToMeta(uri: string, token: string, filePath: string): Promise<void> {
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

// Crea el contenedor, sube los bytes y espera a que Meta termine de procesar. Tira si
// cualquier paso falla (incluye el rechazo típico "ProcessingFailedError" al subir bytes).
async function createAndWaitContainer(
  filePath: string,
  ctx: { instagram_user_id: string; access_token: string; fullCaption: string; thumbOffset?: number },
  onProgress?: (phase: 'uploading' | 'processing', percent?: number) => void,
): Promise<string> {
  const { instagram_user_id, access_token, fullCaption, thumbOffset } = ctx;

  const containerPayload: Record<string, any> = {
    media_type:    'REELS',
    upload_type:   'resumable',
    caption:       fullCaption,
    share_to_feed: true,
    access_token,
  };
  if (thumbOffset != null) containerPayload.thumb_offset = Math.round(Number(thumbOffset) * 1000);
  // El crossposting a Facebook NO va acá: cross_post_facebook_reels no es un
  // parámetro documentado y Meta lo ignoraba en silencio (por eso "nunca
  // funcionó"). Se publica aparte en la Página vía publishReelToFacebookPage().

  const containerData = await igPost(`/${instagram_user_id}/media`, containerPayload);
  appendDebugLog(`[trace] contenedor creado: id=${containerData.id ?? 'NINGUNO'} uri=${containerData.uri ?? 'NINGUNA'} error=${JSON.stringify(containerData.error ?? null)}`);
  if (!containerData.id) {
    // Devolvemos el objeto de error completo (code/subcode/fbtrace_id) al frontend
    // para diagnosticar sin depender de logs de consola (la app empaquetada no
    // muestra stdout al usuario).
    const metaError = containerData.error ?? containerData;
    throw new Error(
      (metaError.error_user_msg || metaError.message || 'Error al crear contenedor de media') +
      ` [raw: ${JSON.stringify(metaError)}]`
    );
  }

  const containerId = containerData.id as string;
  const uploadUri   = containerData.uri as string;
  if (!uploadUri) throw new Error('No se obtuvo upload URI de Meta');

  appendDebugLog(`[trace] subiendo bytes a Meta: ${filePath}`);
  // No se reporta % acá: streamFileToMeta manda el buffer completo de una — es
  // el envío que Meta acepta (ver comentario de la función), tocarlo para medir
  // bytes en tránsito arriesga romper una integración ya validada.
  onProgress?.('uploading');
  await streamFileToMeta(uploadUri, access_token, filePath);
  appendDebugLog(`[trace] subida de bytes a Meta OK, esperando procesamiento`);

  let statusCode = 'IN_PROGRESS';
  for (let i = 0; i < 72 && statusCode === 'IN_PROGRESS'; i++) {
    onProgress?.('processing', Math.round((i / 72) * 100));
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

  return containerId;
}

// Publica el MISMO archivo como Reel en la Página de Facebook vía la Reels
// Publishing API (/{page_id}/video_reels). Es el crossposting robusto: el
// "Compartir a Facebook" manual desde la app de IG falla con "no se puede
// reusar el audio" en reels subidos por API (el audio queda registrado como
// audio original de ese reel), y el flag del contenedor no existía. Publicar
// directo en la Página evita ambos. Requiere el scope pages_manage_posts.
async function publishReelToFacebookPage(
  filePath: string,
  pageId: string,
  pageToken: string,
  description: string,
): Promise<{ videoId: string; url: string }> {
  // 1. Iniciar sesión de subida → video_id + upload_url (rupload.facebook.com)
  const start = await igPost(`/${pageId}/video_reels`, { upload_phase: 'start', access_token: pageToken });
  appendDebugLog(`[trace][fb] start: video_id=${start.video_id ?? 'NINGUNO'} error=${JSON.stringify(start.error ?? null)}`);
  if (!start.video_id || !start.upload_url) {
    throw new Error(start.error?.message ?? `No se pudo iniciar la subida a Facebook [${JSON.stringify(start)}]`);
  }

  // 2. Subir los bytes — mismo protocolo (OAuth + offset + file_size) que el
  //    resumable upload de Instagram, se reusa el helper tal cual.
  await streamFileToMeta(start.upload_url, pageToken, filePath);
  appendDebugLog(`[trace][fb] bytes subidos OK`);

  // 3. Publicar
  const finish = await igPost(`/${pageId}/video_reels`, {
    upload_phase: 'finish',
    video_id:     start.video_id,
    video_state:  'PUBLISHED',
    description,
    access_token: pageToken,
  });
  if (finish.error) throw new Error(finish.error.message ?? 'Error al publicar el Reel en Facebook');

  // 4. Espera acotada a que Meta procese/publique. Si no llega en ese tiempo
  //    igual es éxito — el video ya quedó encolado del lado de Meta.
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await igGet(`/${start.video_id}?fields=status`, pageToken);
    const phase = st.status?.publishing_phase?.status ?? st.status?.video_status;
    if (st.status?.video_status === 'error') {
      throw new Error(`Facebook rechazó el video [${JSON.stringify(st.status)}]`);
    }
    if (phase === 'complete' || st.status?.video_status === 'ready') break;
  }

  appendDebugLog(`[trace][fb] publicado: ${start.video_id}`);
  return { videoId: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}` };
}

// POST /api/instagram/upload
export const uploadToInstagram = async (req: Request, res: Response): Promise<void> => {
  const { fileId, caption = '', tags = [], thumbOffset, crossPostFacebook = false, trimStartSec = 0, trimDurationSec } = req.body;
  appendDebugLog(`[trace] uploadToInstagram llamado — fileId=${fileId}`);
  if (!fileId) { res.status(400).json({ error: 'fileId requerido' }); return; }

  const fileDoc = fileRepo.findById(fileId);
  if (!fileDoc)                             { appendDebugLog(`[trace] fileId=${fileId} no encontrado en DB`); res.status(404).json({ error: 'Archivo no encontrado' }); return; }
  if (fileDoc.status === 'ELIMINADO_DISCO') { appendDebugLog(`[trace] ${fileDoc.file_name} está ELIMINADO_DISCO`); res.status(400).json({ error: 'El archivo fue eliminado del disco' }); return; }
  if (!fs.existsSync(fileDoc.file_path))   { appendDebugLog(`[trace] ${fileDoc.file_name} no existe físicamente en ${fileDoc.file_path}`); res.status(400).json({ error: 'Archivo físico no encontrado' }); return; }

  appendDebugLog(`[trace] ${fileDoc.file_name} pasó validaciones — pidiendo token a la central`);
  let tokenData: { access_token: string; instagram_user_id: string };
  try {
    tokenData = await fetchToken(req.headers.authorization!);
  } catch (err: any) {
    appendDebugLog(`[trace] fetchToken falló: ${err.message}`);
    res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
    return;
  }

  const { access_token, instagram_user_id, page_id } = tokenData;
  const hashtagLine = (tags as string[]).length ? '\n\n' + (tags as string[]).map(t => `#${t}`).join(' ') : '';
  const fullCaption = String(caption) + hashtagLine;
  const ctx = { instagram_user_id, access_token, fullCaption, thumbOffset };
  const jobId = `instagram-${fileId}`;
  const reportProgress = (phase: 'uploading' | 'processing', percent?: number) =>
    setUploadProgress(jobId, { platform: 'instagram', title: fullCaption, phase, percent });

  // Meta rechaza (ProcessingFailedError genérico, sin decir la causa real) algunos videos
  // sin explicar por qué. Confirmado que la causa más común es la DURACIÓN — cuentas sin el
  // rollout de Reels extendido quedan topeadas a 60s vía la API, sin importar el encoding.
  // En vez de adivinar de antemano, subimos en 3 intentos escalonados y nos quedamos con el
  // primero que Meta acepte: (1) el original tal cual, (2) recortado a 60s, (3) recortado y
  // además re-codificado a un baseline seguro (H.264/yuv420p/AAC/faststart, resolución/bitrate
  // acotados). Cada intento solo genera el archivo intermedio si el anterior falló.
  const tempFiles: string[] = [];
  const stages: { label: UploadStage; getPath: () => Promise<string> }[] = [
    { label: 'original', getPath: async () => fileDoc.file_path },
    { label: 'recorte-60s', getPath: async () => {
        const trimmed = await trimToMaxDuration(fileDoc.file_path, Number(trimStartSec) || 0, Number(trimDurationSec) || undefined);
        tempFiles.push(trimmed);
        return trimmed;
      } },
    { label: 'recorte-60s+normalizado', getPath: async () => {
        const trimmed = tempFiles[0] ?? await trimToMaxDuration(fileDoc.file_path, Number(trimStartSec) || 0, Number(trimDurationSec) || undefined);
        if (!tempFiles.includes(trimmed)) tempFiles.push(trimmed);
        const normalized = await normalizeForMeta(trimmed);
        tempFiles.push(normalized.outputPath);
        return normalized.outputPath;
      } },
  ];

  let containerId: string | null = null;
  let usedStage: UploadStage = 'original';
  let usedPath: string = fileDoc.file_path; // el archivo que IG aceptó — Facebook recibe ese mismo
  let lastErr: any = null;

  for (const stage of stages) {
    try {
      const candidatePath = await stage.getPath();
      appendDebugLog(`[trace] intentando etapa "${stage.label}" con ${candidatePath}`);
      containerId = await createAndWaitContainer(candidatePath, ctx, reportProgress);
      usedStage = stage.label;
      usedPath = candidatePath;
      break;
    } catch (err: any) {
      lastErr = err;
      appendDebugLog(`[trace] etapa "${stage.label}" falló: ${err.message}`);
    }
  }

  try {
    if (!containerId) throw lastErr ?? new Error('No se pudo subir el video a Instagram');

    // Publicar (una sola vez, con el intento que sí funcionó)
    const publishData = await igPost(`/${instagram_user_id}/media_publish`, {
      creation_id: containerId,
      access_token,
    });
    if (!publishData.id) throw new Error(publishData.error?.message ?? 'Error al publicar');

    const mediaData = await igGet(`/${publishData.id}?fields=permalink`, access_token);
    const postUrl = (mediaData.permalink as string | undefined) ?? 'https://www.instagram.com/';

    // Guardar en SQLite local
    platformVideoRepo.upsert({
      platform:       'instagram',
      platform_id:    publishData.id,
      platform_url:   postUrl,
      published_at:   new Date(),
      linked_file_id: Number(fileId),
      match_status:   'manual',
      title:          fullCaption.slice(0, 300) || undefined,
    });
    await reportUploadEvent(req.headers.authorization, {
      platform: 'instagram', platformId: publishData.id, platformUrl: postUrl,
      fileName: fileDoc.file_name, contentId: fileDoc.content_id, title: fullCaption,
    });
    // Crossposting robusto: el mismo archivo que IG aceptó se publica como Reel
    // en la Página de Facebook. No-fatal: si falla, IG ya está publicado y se
    // devuelve el detalle para que el usuario sepa que Facebook NO salió.
    let facebookUrl: string | null = null;
    let facebookError: string | null = null;
    if (crossPostFacebook) {
      if (!page_id) {
        facebookError = 'La conexión no tiene una Página de Facebook asociada — reconectá Instagram desde Subir.';
      } else {
        try {
          const fb = await publishReelToFacebookPage(usedPath, page_id, access_token, fullCaption);
          facebookUrl = fb.url;
          platformVideoRepo.upsert({
            platform:       'facebook',
            platform_id:    fb.videoId,
            platform_url:   fb.url,
            published_at:   new Date(),
            linked_file_id: Number(fileId),
            match_status:   'manual',
            title:          fullCaption.slice(0, 300) || undefined,
          });
          await reportUploadEvent(req.headers.authorization, {
            platform: 'facebook', platformId: fb.videoId, platformUrl: fb.url,
            fileName: fileDoc.file_name, contentId: fileDoc.content_id, title: fullCaption,
          });
        } catch (err: any) {
          facebookError = err.message;
          appendDebugLog(`[trace][fb] cross-post falló: ${err.message}`);
        }
      }
    }
    fileRepo.update(fileId, { content_status: 'publicado' });
    fileRepo.addPlatform(fileId, 'instagram');
    // Flujo simple: la subida es un evento único — las demás plataformas que
    // sigan pendientes para este video se resuelven como descartadas.
    const nextIg = fileRepo.findNewerAdjacent(fileDoc, 'instagram');
    configRepo.markPublished('instagram', fileDoc.file_name, fileId, nextIg ? String(nextIg.id) : null);
    syncNextVideoToCentral(req.headers.authorization, 'instagram', {
      lastPublishedDate:  new Date().toISOString().slice(0, 10),
      lastPublishedTitle: fileDoc.file_name,
      nextFile:           nextIg,
    });
    // Solo se marca facebook como publicado si el Reel realmente salió — antes
    // se marcaba siempre que el checkbox estuviera activo, aunque Meta nunca
    // hubiera crossposteado nada.
    if (facebookUrl) fileRepo.addPlatform(fileId, 'facebook');
    pushFilesToCloudInBackground(req.headers.authorization);

    clearUploadProgress(jobId);
    res.json({ ok: true, mediaId: publishData.id, postUrl, crossPostedFacebook: !!facebookUrl, facebookUrl, facebookError, uploadStage: usedStage });
  } catch (err: any) {
    appendDebugLog(`[trace] FALLARON las 3 etapas: ${err.message} | stack: ${err.stack}`);
    console.error('Error al subir a Instagram:', err.message);
    setUploadError(jobId, { platform: 'instagram', title: fullCaption, message: err.message });
    res.status(500).json({ error: 'Error al subir a Instagram', detail: err.message });
  } finally {
    for (const f of tempFiles) fs.unlink(f, () => {});
  }
};
