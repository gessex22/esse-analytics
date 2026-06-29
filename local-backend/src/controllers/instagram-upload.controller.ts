import { Request, Response } from 'express';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { fileRepo } from '../db/file.repo';
import { platformVideoRepo } from '../db/platform-video.repo';
import { configRepo } from '../db/config.repo';
import { pushFilesToCloudInBackground } from './backup-sync.controller';

const IG_GRAPH = 'https://graph.instagram.com/v22.0';
const CENTRAL  = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

async function fetchToken(authHeader: string): Promise<{ access_token: string; instagram_user_id: string }> {
  const res = await fetch(`${CENTRAL}/api/instagram/token`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    throw new Error('NO_AUTH');
  }
  return res.json() as Promise<{ access_token: string; instagram_user_id: string }>;
}

async function igGet(path: string, token: string): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${IG_GRAPH}${path}${sep}access_token=${token}`);
  return res.json();
}

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

// Sube el archivo directamente a Meta (sin URL pública — upload resumable desde local)
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

// POST /api/instagram/upload
export const uploadToInstagram = async (req: Request, res: Response): Promise<void> => {
  const { fileId, caption = '', tags = [], thumbOffset, crossPostFacebook = false } = req.body;
  if (!fileId) { res.status(400).json({ error: 'fileId requerido' }); return; }

  const fileDoc = fileRepo.findById(fileId);
  if (!fileDoc)                             { res.status(404).json({ error: 'Archivo no encontrado' }); return; }
  if (fileDoc.status === 'ELIMINADO_DISCO') { res.status(400).json({ error: 'El archivo fue eliminado del disco' }); return; }
  if (!fs.existsSync(fileDoc.file_path))   { res.status(400).json({ error: 'Archivo físico no encontrado' }); return; }

  let tokenData: { access_token: string; instagram_user_id: string };
  try {
    tokenData = await fetchToken(req.headers.authorization!);
  } catch {
    res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de Instagram primero' });
    return;
  }

  const { access_token, instagram_user_id } = tokenData;
  const fileSize = fs.statSync(fileDoc.file_path).size;
  const hashtagLine = (tags as string[]).length ? '\n\n' + (tags as string[]).map(t => `#${t}`).join(' ') : '';
  const fullCaption = String(caption) + hashtagLine;

  try {
    // 1. Crear contenedor con upload_type: resumable (sube el archivo directo, sin URL pública)
    const containerPayload: Record<string, any> = {
      media_type:    'REELS',
      upload_type:   'resumable',
      caption:       fullCaption,
      share_to_feed: true,
      access_token,
    };
    if (thumbOffset != null) containerPayload.thumb_offset = Math.round(Number(thumbOffset) * 1000);
    if (crossPostFacebook) containerPayload.cross_post_facebook_reels = true;

    const containerData = await igPost(`/${instagram_user_id}/media`, containerPayload);
    if (!containerData.id) throw new Error(containerData.error?.message ?? 'Error al crear contenedor de media');

    const containerId = containerData.id as string;
    const uploadUri   = containerData.uri as string;

    if (!uploadUri) throw new Error('No se obtuvo upload URI de Instagram');

    // 2. Subir archivo directo a Meta desde esta máquina
    await streamFileToMeta(uploadUri, access_token, fileDoc.file_path, fileSize);

    // 3. Esperar procesamiento
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

    // 4. Publicar
    const publishData = await igPost(`/${instagram_user_id}/media_publish`, {
      creation_id: containerId,
      access_token,
    });
    if (!publishData.id) throw new Error(publishData.error?.message ?? 'Error al publicar');

    const mediaData = await igGet(`/${publishData.id}?fields=permalink`, access_token);
    const postUrl = (mediaData.permalink as string | undefined) ?? 'https://www.instagram.com/';

    // 5. Guardar en SQLite local
    platformVideoRepo.upsert({
      platform:       'instagram',
      platform_id:    publishData.id,
      platform_url:   postUrl,
      published_at:   new Date(),
      linked_file_id: Number(fileId),
      match_status:   'manual',
      title:          fullCaption.slice(0, 300) || undefined,
    });
    if (crossPostFacebook) {
      platformVideoRepo.upsert({
        platform:       'facebook',
        platform_id:    `fb_xpost_${publishData.id}`,
        platform_url:   '',
        published_at:   new Date(),
        linked_file_id: Number(fileId),
        match_status:   'manual',
        title:          fullCaption.slice(0, 300) || undefined,
      });
    }
    fileRepo.update(fileId, { content_status: 'publicado' });
    fileRepo.addPlatform(fileId, 'instagram');
    const nextIg = fileRepo.findNewerAdjacent(fileDoc);
    configRepo.markPublished('instagram', fileDoc.file_name, fileId, nextIg ? String(nextIg.id) : null);
    if (crossPostFacebook) fileRepo.addPlatform(fileId, 'facebook');
    pushFilesToCloudInBackground(req.headers.authorization);

    res.json({ ok: true, mediaId: publishData.id, postUrl, crossPostedFacebook: !!crossPostFacebook });
  } catch (err: any) {
    console.error('Error al subir a Instagram:', err.message);
    res.status(500).json({ error: 'Error al subir a Instagram', detail: err.message });
  }
};
