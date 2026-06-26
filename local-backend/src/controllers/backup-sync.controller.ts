import { Request, Response } from 'express';
import { fileRepo } from '../db/file.repo';
import { configRepo } from '../db/config.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// POST /api/local/backup/push
// Reads all SQLite files and sends them to the central cloud.
export async function pushToCloud(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ error: 'Token requerido' }); return; }

  try {
    const { rows } = fileRepo.findAll({ limit: 50000, offset: 0 });

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

    const upstream = await fetch(`${CENTRAL}/api/backup/files/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ files }),
    });

    if (!upstream.ok) {
      const detail = await upstream.json().catch(() => ({}));
      res.status(502).json({ error: 'Error en central', detail });
      return;
    }

    const result = await upstream.json();
    configRepo.set('backup_last_push', new Date().toISOString());
    res.json({ ok: true, localCount: files.length, ...result });
  } catch (err: any) {
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

    for (const cf of cloudFiles) {
      const { rows } = fileRepo.findAll({ search: cf.file_name, limit: 5, offset: 0 });
      const localFile = rows.find(r => r.file_name === cf.file_name);

      if (!localFile) {
        orphans++;
        continue;
      }

      const cloudTs = new Date(cf.local_updated_at).getTime();
      const localTs = new Date(localFile.updated_at).getTime();

      if (cloudTs > localTs) {
        fileRepo.update(localFile.id, {
          platforms:           cf.platforms           ?? [],
          platforms_discarded: cf.platforms_discarded ?? [],
          content_status:      cf.content_status      ?? localFile.content_status,
          ...('tipo_contenido' in cf ? { tipo_contenido: cf.tipo_contenido ?? null } : {}),
          ...(cf.scheduled_date != null ? { scheduled_date: cf.scheduled_date } : {}),
        });
        updated++;
      } else {
        skipped++;
      }
    }

    configRepo.set('backup_last_pull', new Date().toISOString());
    res.json({ ok: true, cloudCount: cloudFiles.length, updated, skipped, orphans });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/local/backup/status
export function getLocalBackupStatus(_req: Request, res: Response): void {
  const localCount = fileRepo.countAll();
  const lastPush   = configRepo.get('backup_last_push');
  const lastPull   = configRepo.get('backup_last_pull');
  const lastSync   = lastPush && lastPull
    ? new Date(Math.max(new Date(lastPush).getTime(), new Date(lastPull).getTime())).toISOString()
    : lastPush ?? lastPull ?? null;
  res.json({ localCount, lastPush, lastPull, lastSync });
}
