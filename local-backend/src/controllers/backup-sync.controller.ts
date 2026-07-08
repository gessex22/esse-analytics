import { Request, Response } from 'express';
import { fileRepo } from '../db/file.repo';
import { configRepo } from '../db/config.repo';
import { transcriptRepo } from '../db/transcript.repo';
import { platformVideoRepo } from '../db/platform-video.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// Lee todo el SQLite y lo sube al espejo central. Reutilizable desde el endpoint
// y desde los controllers de subida (push inmediato tras publicar).
export async function pushFilesToCloud(authHeader: string): Promise<{ localCount: number; [k: string]: any }> {
  const video_folder = configRepo.get('videos_dir') ?? null;

  // Sin carpeta configurada todavía (instalación recién logueada, esperando que el
  // usuario elija su carpeta de videos): no hay nada real que respaldar. Si
  // pusheáramos igual con fullSync, el central interpretaría "0 archivos" como
  // "borralos todos" y archivaría el catálogo entero de otra instalación.
  if (!video_folder) return { localCount: 0, updated: 0, skipped: 0 };

  // Solo archivos activos: los borrados del disco no deben verse en el remoto.
  const { rows } = fileRepo.findAll({ excludeStatus: 'ELIMINADO_DISCO', limit: 50000, offset: 0 });

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
  // reconciliar (quitar del remoto lo que ya no existe localmente). Una instalación
  // secundaria (PC distinta con solo un subconjunto de videos) NUNCA debe reconciliar
  // así, o archivaría en la nube los videos que solo existen en la PC principal.
  const isSecondary = configRepo.get('secondary_install') === '1';
  const upstream = await fetch(`${CENTRAL}/api/backup/files/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ files, video_folder, fullSync: !isSecondary }),
  });

  if (!upstream.ok) {
    const detail = await upstream.json().catch(() => ({}));
    // Preserva el status/mensaje real de la central (p.ej. 403 "Esta función
    // requiere plan Premium.") en vez de un genérico "Error en central" que
    // no le dice nada al usuario.
    throw Object.assign(new Error(detail?.message || 'Error en central'), { detail, status: upstream.status });
  }

  const result = await upstream.json();
  configRepo.set('backup_last_push', new Date().toISOString());

  // Respaldo real de las transcripciones — antes no existía ningún push, así que
  // el wipe de datos locales (p.ej. al cerrar sesión) las borraba sin posibilidad
  // de recuperarlas. Se espera (no fire-and-forget): el logout hace wipe apenas
  // este push termina, así que si no lo esperamos podría borrar antes de subir.
  // No fatal para el push de archivos si esto falla.
  try {
    await pushTranscriptsToCloud(authHeader);
  } catch (err: any) {
    console.warn('[backup] push de transcripciones falló:', err.message);
  }

  // Vínculo real archivo↔publicación (platform_id/URL/fecha) — el wipe de logout borra
  // platform_videos entero en SQLite; sin este push esa info no tenía ninguna copia.
  try {
    await pushPlatformVideosToCloud(authHeader);
  } catch (err: any) {
    console.warn('[backup] push de platform_videos falló:', err.message);
  }

  // Preferencia de flujo (simple/avanzado) + colas de calendario por plataforma.
  // No fatal: si falla, el push de archivos ya se hizo.
  try {
    await pushConfigToCloud(authHeader);
  } catch (err: any) {
    console.warn('[backup] push de configuración falló:', err.message);
  }

  return { localCount: files.length, ...result };
}

// Los IDs de archivo en platform_videos.linked_file_id son locales a este SQLite → se
// mandan por file_name (igual que platform_config), y se resuelven de vuelta a IDs
// locales recién al hacer pull.
async function pushPlatformVideosToCloud(authHeader: string): Promise<void> {
  const rows = platformVideoRepo.findAll();
  if (rows.length === 0) return;

  const videos = rows.map(pv => ({
    platform:         pv.platform,
    platform_id:      pv.platform_id,
    platform_url:     pv.platform_url    ?? null,
    published_at:     pv.published_at    ?? null,
    file_name:        pv.linked_file_id ? fileRepo.findById(pv.linked_file_id)?.file_name ?? null : null,
    match_status:     pv.match_status,
    title:            pv.title           ?? null,
    description:      pv.description     ?? null,
    local_updated_at: pv.updated_at,
  }));

  await fetch(`${CENTRAL}/api/backup/platform-videos/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ videos }),
  });
}

async function pushTranscriptsToCloud(authHeader: string): Promise<void> {
  const transcripts = transcriptRepo.findAllWithFileName()
    .map(t => ({ file_name: t.file_name, transcript_text: t.text, language: t.language }));
  if (transcripts.length === 0) return;

  await fetch(`${CENTRAL}/api/backup/transcripts/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ transcripts }),
  });
}

// Los IDs de video en platform_config son locales a este SQLite (no tienen sentido
// en otra máquina) → se guardan por file_name, igual que el import-calendar manual,
// y se resuelven de vuelta a IDs locales recién al hacer pull.
async function pushConfigToCloud(authHeader: string): Promise<void> {
  const workflow_mode = configRepo.get('workflow_mode');
  const platform_configs = configRepo.getAllPlatformConfigs().map((pc: any) => ({
    platform:              pc.platform,
    last_published_title:  pc.last_published_title  ?? null,
    last_published_date:   pc.last_published_date   ?? null,
    interval_days:         pc.interval_days          ?? null,
    last_video_name:       pc.last_video_id ? fileRepo.findById(pc.last_video_id)?.file_name ?? null : null,
    next_video_name:       pc.next_video_id ? fileRepo.findById(pc.next_video_id)?.file_name ?? null : null,
  }));

  await fetch(`${CENTRAL}/api/backup/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ workflow_mode, platform_configs }),
  });
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
    if (err.status) { res.status(err.status).json({ error: err.message, detail: err.detail }); return; }
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
      const detail = await upstream.json().catch(() => ({}));
      res.status(upstream.status).json({ error: detail?.message || 'No se pudo obtener el backup del cloud', detail });
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

    // Config (workflow_mode + colas por plataforma) — solo rellena lo que falte
    // localmente, nunca pisa una preferencia o cola que la máquina ya tenga activa.
    try {
      await pullConfigFromCloud(authHeader);
    } catch (err: any) {
      console.warn('[backup] pull de configuración falló:', err.message);
    }

    // Vínculo real archivo↔publicación (platform_videos) — el wipe de logout lo borra
    // entero; sin este pull quedaba solo el flag "platforms: ['youtube']" en el archivo,
    // pero se perdía el platform_id/URL/fecha exactos de la publicación.
    let platformVideos = { recovered: 0, skipped: 0, orphans: 0 };
    try {
      platformVideos = await pullPlatformVideosFromCloud(authHeader);
    } catch (err: any) {
      console.warn('[backup] pull de platform_videos falló:', err.message);
    }

    configRepo.set('backup_last_pull', new Date().toISOString());
    res.json({ ok: true, cloudCount: cloudFiles.length, cloudWithPlatforms, updated, recovered, skipped, orphans, platformVideos });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// Trae de la nube el vínculo real archivo↔publicación y lo reconstruye en la tabla local
// platform_videos, matcheando por file_name (los linked_file_id no son portables). Si ya
// existe un registro local con el mismo platform+platform_id no lo toca (no pisa nada que
// la máquina ya tenga); si el archivo vinculado no existe localmente, se reporta como huérfano.
async function pullPlatformVideosFromCloud(authHeader: string): Promise<{ recovered: number; skipped: number; orphans: number }> {
  const upstream = await fetch(`${CENTRAL}/api/backup/platform-videos`, { headers: { Authorization: authHeader } });
  if (!upstream.ok) return { recovered: 0, skipped: 0, orphans: 0 };

  const { videos: cloudVideos }: { videos: any[] } = await upstream.json();

  let recovered = 0, skipped = 0, orphans = 0;

  for (const cv of cloudVideos) {
    const existing = platformVideoRepo.findByPlatformAndId(cv.platform, cv.platform_id);
    if (existing) { skipped++; continue; }

    const file = cv.file_name ? fileRepo.findByName(cv.file_name) : undefined;
    if (cv.file_name && !file) { orphans++; continue; }

    platformVideoRepo.upsert({
      platform:       cv.platform,
      platform_id:    cv.platform_id,
      platform_url:   cv.platform_url  ?? undefined,
      published_at:   cv.published_at  ?? undefined,
      linked_file_id: file?.id,
      match_status:   cv.match_status  ?? 'sin_match',
      title:          cv.title         ?? undefined,
      description:    cv.description   ?? undefined,
    });
    recovered++;
  }

  return { recovered, skipped, orphans };
}

async function pullConfigFromCloud(authHeader: string): Promise<void> {
  const upstream = await fetch(`${CENTRAL}/api/backup/config`, { headers: { Authorization: authHeader } });
  if (!upstream.ok) return;
  const cfg: { workflow_mode: string | null; platform_configs: any[] } = await upstream.json();

  if (cfg.workflow_mode && !configRepo.get('workflow_mode')) {
    configRepo.set('workflow_mode', cfg.workflow_mode);
  }

  for (const pc of cfg.platform_configs ?? []) {
    if (!pc.platform || configRepo.getPlatformConfig(pc.platform)) continue; // no pisa una cola local ya activa
    const lastFile = pc.last_video_name ? fileRepo.findByName(pc.last_video_name) : undefined;
    const nextFile = pc.next_video_name ? fileRepo.findByName(pc.next_video_name) : undefined;
    configRepo.setPlatformConfig(pc.platform, {
      last_published_title: pc.last_published_title ?? undefined,
      last_published_date:  pc.last_published_date  ?? undefined,
      interval_days:        pc.interval_days         ?? undefined,
      last_video_id:        lastFile ? String(lastFile.id) : null,
      next_video_id:        nextFile ? String(nextFile.id) : null,
    });
  }
}

// POST /api/local/backup/pull-transcripts
// Trae las transcripciones desde la central y las escribe en SQLite, matcheando por
// file_name. No hay push de transcripciones (no hay otra copia), así que nunca pisa
// una que ya exista localmente — solo rellena las que faltan (p.ej. tras un wipe).
export async function pullTranscriptsFromCloud(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ error: 'Token requerido' }); return; }

  try {
    const upstream = await fetch(`${CENTRAL}/api/backup/transcripts`, {
      headers: { Authorization: authHeader },
    });

    if (!upstream.ok) {
      const detail = await upstream.json().catch(() => ({}));
      res.status(upstream.status).json({ error: detail?.message || 'No se pudo obtener transcripts del cloud', detail });
      return;
    }

    const { transcripts: cloudTranscripts }: { transcripts: { file_name: string; transcript_text: string; language: string }[] } =
      await upstream.json();

    let recovered = 0, skipped = 0, orphans = 0;

    for (const ct of cloudTranscripts) {
      const file = fileRepo.findByName(ct.file_name);
      if (!file) { orphans++; continue; }

      const existing = transcriptRepo.findByFileId(file.id);
      if (existing) { skipped++; continue; }

      transcriptRepo.upsert(file.id, ct.transcript_text, ct.language || 'es');
      recovered++;
    }

    res.json({ ok: true, cloudCount: cloudTranscripts.length, recovered, skipped, orphans });
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
  const isSecondary = configRepo.get('secondary_install') === '1';
  const lastSync   = lastPush && lastPull
    ? new Date(Math.max(new Date(lastPush).getTime(), new Date(lastPull).getTime())).toISOString()
    : lastPush ?? lastPull ?? null;
  res.json({ localCount, lastPush, lastPull, lastSync, videosDir, isSecondary });
}

// POST /api/local/setup/mark-secondary
// El frontend la llama cuando detecta que esta PC no es la principal (auto-detect
// de la carpeta falló pero la nube ya tiene catálogo): a partir de acá, todo push
// desde esta instalación va sin fullSync para no archivar videos de otra PC.
export function markSecondaryInstall(_req: Request, res: Response): void {
  configRepo.set('secondary_install', '1');
  res.json({ ok: true });
}
