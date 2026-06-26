import { Request, Response } from 'express';
import fs from 'fs';
import { fileRepo } from '../db/file.repo';
import { platformVideoRepo } from '../db/platform-video.repo';

const TK_BASE    = 'https://open.tiktokapis.com/v2';
const CENTRAL    = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB

async function fetchToken(authHeader: string): Promise<{ access_token: string; open_id: string }> {
  const res = await fetch(`${CENTRAL}/api/tiktok/token`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw Object.assign(new Error(err.message ?? 'NO_AUTH'), { code: 'NO_AUTH' });
  }
  return res.json() as Promise<{ access_token: string; open_id: string }>;
}

// Sube el archivo en chunks directamente a TikTok (FILE_UPLOAD) sin pasar por la central
async function uploadChunks(uploadUrl: string, filePath: string, fileSize: number, chunkSize: number): Promise<void> {
  const totalChunks = Math.ceil(fileSize / chunkSize);
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end   = Math.min(start + chunkSize, fileSize) - 1;
      const size  = end - start + 1;
      const buf   = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, start);

      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type':  'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': String(size),
        },
        body: buf,
      });
      if (!res.ok && res.status !== 206) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Chunk ${i + 1}/${totalChunks} falló (${res.status}): ${txt.slice(0, 200)}`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

// POST /api/tiktok/upload
export const uploadToTikTok = async (req: Request, res: Response): Promise<void> => {
  const {
    fileId, title = '', privacyLevel, thumbOffsetMs = 1000,
    disableDuet = false, disableComment = false, disableStitch = false,
    brandOrganic = false, brandedContent = false,
  } = req.body;

  if (!fileId)       { res.status(400).json({ error: 'fileId requerido' }); return; }
  if (!privacyLevel) { res.status(400).json({ error: 'Debes seleccionar la privacidad' }); return; }

  const fileDoc = fileRepo.findById(fileId);
  if (!fileDoc)                             { res.status(404).json({ error: 'Archivo no encontrado' }); return; }
  if (fileDoc.status === 'ELIMINADO_DISCO') { res.status(400).json({ error: 'El archivo fue eliminado del disco' }); return; }
  if (!fs.existsSync(fileDoc.file_path))   { res.status(400).json({ error: 'Archivo físico no encontrado' }); return; }

  let token: { access_token: string; open_id: string };
  try {
    token = await fetchToken(req.headers.authorization!);
  } catch {
    res.status(401).json({ error: 'NO_AUTH', message: 'Conecta tu cuenta de TikTok primero' });
    return;
  }

  const fileSize = fs.statSync(fileDoc.file_path).size;

  try {
    // 1. Iniciar upload (FILE_UPLOAD — sin URL pública, directo desde local)
    const initRes = await fetch(`${TK_BASE}/post/publish/video/init/`, {
      method: 'POST',
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
          source:      'FILE_UPLOAD',
          video_size:  fileSize,
          chunk_size:  CHUNK_SIZE,
          total_chunk_count: Math.ceil(fileSize / CHUNK_SIZE),
        },
      }),
    });
    const initData = await initRes.json() as any;
    if (initData.error?.code !== 'ok') {
      throw new Error(initData.error?.message ?? 'Error al iniciar publicación en TikTok');
    }

    const { publish_id, upload_url } = initData.data as { publish_id: string; upload_url: string };

    // 2. Subir chunks directo a TikTok desde esta máquina
    await uploadChunks(upload_url, fileDoc.file_path, fileSize, CHUNK_SIZE);

    // 3. Esperar procesamiento
    let publishStatus = 'PROCESSING_UPLOAD';
    for (let i = 0; i < 60 && !['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED'].includes(publishStatus); i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusRes = await fetch(`${TK_BASE}/post/publish/status/fetch/`, {
        method: 'POST',
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

    const platformUrl = `https://www.tiktok.com/@${token.open_id}/video/${publish_id}`;

    // 4. Guardar en SQLite local
    platformVideoRepo.upsert({
      platform:       'tiktok',
      platform_id:    publish_id,
      platform_url:   platformUrl,
      published_at:   new Date(),
      linked_file_id: Number(fileId),
      match_status:   'manual',
    });
    fileRepo.update(fileId, { content_status: 'publicado' });
    fileRepo.addPlatform(fileId, 'tiktok');

    res.json({ ok: true, publishId: publish_id, status: publishStatus, sentToInbox: publishStatus === 'SEND_TO_USER_INBOX' });
  } catch (err: any) {
    console.error('Error al subir a TikTok:', err.message);
    res.status(500).json({ error: 'Error al subir a TikTok', detail: err.message });
  }
};
