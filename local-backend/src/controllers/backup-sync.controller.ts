import { Request, Response } from 'express';
import { fileRepo } from '../db/file.repo';
import { configRepo } from '../db/config.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// Lee todo el SQLite y lo sube al espejo central. Reutilizable desde el endpoint
// y desde los controllers de subida (push inmediato tras publicar).
export async function pushFilesToCloud(authHeader: string): Promise<{ localCount: number; [k: string]: any }> {
  // Solo archivos activos: los borrados del disco no deben verse en el remoto.
  const { rows } = fileRepo.findAll({ excludeStatus: 'ELIMINADO_DISCO', limit: 50000, offset: 0 });
  const video_folder = configRepo.get('videos_dir') ?? null;

  const files = rows.map(f => ({
    file_name:           f.file_name,
    platforms:           f.platforms,
    platforms_discarded: f.platforms_discarded,
    tipo_contenido:      f.tipo_contenido      ?? null,
    content_status:      f.content_status,
    scheduled_date:      f.scheduled_date      ?? null,
    duracion_segundos:   f.duracion_segundos   ?? null,
    resolucion:          f.resolucion          ?? null,
    formato:             f.formato             ?? null,
    fecha_creacion:      f.fecha_creacion      ?? null,
    local_updated_at:    f.updated_at,
  }));

  // fullSync: este push contiene TODOS los archivos activos → el central puede
  // reconciliar (quitar del remoto lo que ya no existe localmente).
  const upstream = await fetch(`${CENTRAL}/api/backup/files/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ files, video_folder, fullSync: true }),
  });

  if (!upstream.ok) {
    const detail = await upstream.json().catch(() => ({}));
    throw Object.assign(new Error('Error en central'), { detail, status: 502 });
  }

  const result = await upstream.json();
  configRepo.set('backup_last_push', new Date().toISOString());
  return { localCount: files.length, ...result };
}

// Dispara un push en segundo plano sin bloquear la respuesta del caller.
// Pensado para llamarse tras una publicación: deja la nube fresca al instante.
export function pushFilesToCloudInBackground(authHeader?: string): void {
  if (!authHeader) return;
  setImmediate(() => {
    pushFilesToCloud(authHeader).catch(err => {
      console.warn('[backup] push automático tras publicar falló:', err.message);
    });
  });
}

// POST /api/local/backup/push
// Reads all SQLite files and sends them to the central cloud.
export async function pushToCloud(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ error: 'Token requerido' }); return; }

  try {
    const result = await pushFilesToCloud(authHeader);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    if (err.status === 502) { res.status(502).json({ error: 'Error en central', detail: err.detail }); return; }
    res.status(500).json({ error: err.message });
  }
}

// POST /api/local/backup/pull
// Fetches cloud records and merges metadata into matching local SQLite files.
// Records in cloud that have no local match are reported as orphans (not created).
export async function pullFromCloud(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ error: 'Token requerido' }); return; }

  try {
    const upstream = await fetch(`${CENTRAL}/api/backup/files`, {
      headers: { Authorization: authHeader },
    });

    if (!upstream.ok) {
      res.status(502).json({ error: 'No se pudo obtener el backup del cloud' });
      return;
    }

    const { files: cloudFiles }: { files: any[] } = await upstream.json();

    let updated = 0;
    let skipped = 0;
    let orphans = 0;
    let recovered = 0;
    let cloudWithPlatforms = 0;

    const hasData = (arr: any) => Array.isArray(arr) && arr.length > 0;

    for (const cf of cloudFiles) {
      if (hasData(cf.platforms) || hasData(cf.platforms_discarded)) cloudWithPlatforms++;

      const { rows } = fileRepo.findAll({ search: cf.file_name, limit: 5, offset: 0 });
      const localFile = rows.find(r => r.file_name === cf.file_name);

      if (!localFile) {
        orphans++;
        continue;
      }

      const cloudTs = new Date(cf.local_updated_at).getTime();
      const localTs = new Date(localFile.updated_at).getTime();

      // Modo recuperación: si el local no tiene platforms pero la nube sí,
      // aplicamos sin importar el timestamp (máquina nueva / DB reescaneada).
      const localEmpty = !hasData(localFile.platforms) && !hasData(localFile.platforms_discarded);
      const cloudHas   = hasData(cf.platforms) || hasData(cf.platforms_discarded);

      if (cloudTs > localTs) {
        fileRepo.update(localFile.id, {
          platforms:           cf.platforms           ?? [],
          platforms_discarded: cf.platforms_discarded ?? [],
          content_status:      cf.content_status      ?? localFile.content_status,
          ...('tipo_contenido' in cf ? { tipo_contenido: cf.tipo_contenido ?? null } : {}),
          ...(cf.scheduled_date != null ? { scheduled_date: cf.scheduled_date } : {}),
        });
        updated++;
      } else if (localEmpty && cloudHas) {
        fileRepo.update(localFile.id, {
          platforms:           cf.platforms           ?? [],
          platforms_discarded: cf.platforms_discarded ?? [],
          ...('tipo_contenido' in cf && !localFile.tipo_contenido ? { tipo_contenido: cf.tipo_contenido ?? null } : {}),
        });
        recovered++;
      } else {
        skipped++;
      }
    }

    configRepo.set('backup_last_pull', new Date().toISOString());
    res.json({ ok: true, cloudCount: cloudFiles.length, cloudWithPlatforms, updated, recovered, skipped, orphans });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/local/backup/status
export function getLocalBackupStatus(_req: Request, res: Response): void {
  const localCount = fileRepo.countAll();
  const lastPush   = configRepo.get('backup_last_push');
  const lastPull   = configRepo.get('backup_last_pull');
  const videosDir  = configRepo.get('videos_dir') ?? null;
  const lastSync   = lastPush && lastPull
    ? new Date(Math.max(new Date(lastPush).getTime(), new Date(lastPull).getTime())).toISOString()
    : lastPush ?? lastPull ?? null;
  res.json({ localCount, lastPush, lastPull, lastSync, videosDir });
}
