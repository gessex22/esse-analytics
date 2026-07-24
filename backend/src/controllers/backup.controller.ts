import { Response } from 'express';
import { AuthRequest, isOwner } from '../middleware/auth.middleware';
import { BackupFileModel } from '../models/backup-file.model';
import { TranscriptBackupModel } from '../models/transcript-backup.model';
import { FileModel } from '../models/file.model';
import { UserModel } from '../models/user.model';
import { IdeaCentral } from '../models/ideacentral';
import { BackupConfigModel } from '../models/backup-config.model';
import { BackupPlatformVideoModel } from '../models/backup-platform-video.model';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { UploadHistoryModel } from '../models/upload-history.model';
import { PlatformVideoModel } from '../models/platform-video.model';

// GET /api/backup/files
// Mismo filtro por defecto que la vista principal de Videos del escritorio
// (local-backend/src/db/file.repo.ts, findAll con content_status='no_completo'):
// oculta lo que ya está resuelto (publicado o descartado) en las 3 plataformas.
// Ahí es un WHERE sobre json_array_length(platforms/platforms_discarded); acá se
// replica en memoria sobre el mismo par de arrays que ya viaja en BackupFileModel
// -- sin este filtro, el catálogo de Android mostraba videos que la vista por
// defecto del escritorio no muestra (confirmado por el owner).
//
// ?includeResolved=true salta ese filtro y devuelve TODO -- lo necesita
// pullFromCloud (local-backend/backup-sync.controller.ts) para reconstruir la
// SQLite local tras un wipe: sin esto, un catálogo ya resuelto en las 3
// plataformas (el caso típico tras meses de uso) queda invisible para el pull
// y la recuperación queda incompleta en silencio (bug real detectado en el
// incidente del reset-all de julio 2026 -- ver fix-local-files-platforms.js).
export async function getBackupFiles(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const includeResolved = req.query.includeResolved === 'true';
    const [allFiles, user, centralFiles] = await Promise.all([
      BackupFileModel.find({ userId }).lean(),
      UserModel.findById(userId, { video_folder: 1 }).lean(),
      // BackupFileModel solo tiene lo que ALGUNA instalación local llegó a pushear.
      // Lo que se resolvió por el flujo de Sincronizar/cross-match (central, dueño)
      // nunca pasa por ahí — vive solo en FileModel ('files'). Sin este merge, un
      // wipe de logout + pull no recupera esos videos (bug real, ver incidente de
      // julio 2026 / fix-local-files-platforms.js): el pull queda tan incompleto
      // como el propio push, aunque en la nube exista el dato correcto en otro lado.
      FileModel.find({ userId }).select('file_name platforms platforms_discarded content_status scheduled_date duracion_segundos resolucion formato fecha_creacion updatedAt').lean(),
    ]);

    const centralByName = new Map(centralFiles.map(f => [f.file_name, f]));
    const backupNames = new Set(allFiles.map(f => f.file_name));
    const enriched = allFiles.map(f => {
      const current = (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0);
      if (current >= 3) return f;
      const central = centralByName.get(f.file_name);
      if (!central) return f;
      const centralCount = (central.platforms?.length ?? 0) + (central.platforms_discarded?.length ?? 0);
      if (centralCount <= current) return f;
      return { ...f, platforms: central.platforms ?? f.platforms, platforms_discarded: central.platforms_discarded ?? f.platforms_discarded };
    });
    // Un archivo que se publicó/resolvió por un camino que nunca pasa por
    // BackupFileModel (celular, Biblioteca remota, auto-sync) puede no tener
    // NINGUNA fila ahí todavía -- el .map() de arriba nunca lo agrega, solo
    // enriquece lo que YA existe. Sin esto, el pull del PC ni se enteraba de
    // que ese archivo existía (aunque la SQLite local sí lo tuviera, con el
    // badge viejo) hasta que alguna instalación lo pusheara una vez.
    const onlyInCentral = centralFiles
      .filter(f => !backupNames.has(f.file_name))
      .map(f => ({
        file_name:           f.file_name,
        platforms:           f.platforms           ?? [],
        platforms_discarded: f.platforms_discarded ?? [],
        content_status:      f.content_status      ?? 'borrador',
        scheduled_date:      f.scheduled_date       ?? null,
        duracion_segundos:   f.duracion_segundos    ?? null,
        resolucion:          f.resolucion           ?? null,
        formato:             f.formato              ?? null,
        fecha_creacion:      f.fecha_creacion        ?? null,
        local_updated_at:    (f as any).updatedAt,
      }));
    const merged = [...enriched, ...onlyInCentral];

    const files = includeResolved
      ? merged
      : merged.filter(f => (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0) < 3);
    res.json({ files, total: files.length, video_folder: user?.video_folder ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

const hasData = (arr: any): boolean => Array.isArray(arr) && arr.length > 0;

// POST /api/backup/files/bulk
// Upserts many records. Last-write-wins by local_updated_at — PERO un archivo que
// llega sin platforms/platforms_discarded (p.ej. un re-escaneo de disco tras un wipe,
// que no puede saber dónde se publicó cada video) NUNCA pisa un registro que en la
// nube sí tiene esa info, aunque su timestamp sea más nuevo. Así el backup real
// sobrevive a un catálogo reconstruido desde cero.
export async function bulkUpsertBackupFiles(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const incoming: any[] = req.body.files;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      res.status(400).json({ error: 'files[] requerido' });
      return;
    }

    const fileNames = incoming.map(f => f.file_name);
    const contentIds = incoming.map(f => f.content_id).filter(Boolean);
    // Matchea por content_id (estable ante renombres) o por file_name (registros
    // viejos / clientes que todavía no mandan content_id) — lo que exista primero.
    const existing = await BackupFileModel.find(
      {
        userId,
        $or: [
          { file_name: { $in: fileNames } },
          ...(contentIds.length ? [{ content_id: { $in: contentIds } }] : []),
        ],
      },
      { file_name: 1, content_id: 1, local_updated_at: 1, platforms: 1, platforms_discarded: 1 },
    ).lean();
    const existingByFileName  = new Map(existing.map(e => [e.file_name, e]));
    const existingByContentId = new Map(existing.filter(e => e.content_id).map(e => [e.content_id as string, e]));
    const resolveExisting = (f: any) =>
      (f.content_id && existingByContentId.get(f.content_id)) || existingByFileName.get(f.file_name);

    // Para cada archivo entrante, decide si el valor de platforms que se aplica es
    // el que llegó (incoming) o el que ya había en la nube (protegido).
    function resolvePlatforms(f: any, ex: typeof existing[number] | undefined) {
      const incomingEmpty = !hasData(f.platforms) && !hasData(f.platforms_discarded);
      const existingHasData = !!ex && (hasData(ex.platforms) || hasData(ex.platforms_discarded));
      if (incomingEmpty && existingHasData) {
        return { platforms: ex!.platforms, platforms_discarded: ex!.platforms_discarded, protected: true };
      }
      return { platforms: f.platforms ?? [], platforms_discarded: f.platforms_discarded ?? [], protected: false };
    }

    const toUpdate = incoming.filter(f => {
      const ex = resolveExisting(f);
      const existingTs = ex?.local_updated_at?.getTime();
      const isNewer = !existingTs || existingTs < new Date(f.local_updated_at).getTime();
      // Si no es más nuevo, no hay nada que actualizar (comportamiento previo).
      // Si SÍ es más nuevo pero vendría vacío sobre un registro con datos, igual lo
      // dejamos pasar (para no perder otros campos legítimos), resolvePlatforms se
      // encarga de proteger específicamente platforms/platforms_discarded.
      return isNewer;
    });

    if (toUpdate.length > 0) {
      await BackupFileModel.bulkWrite(
        toUpdate.map(f => {
          const ex = resolveExisting(f);
          const { platforms, platforms_discarded } = resolvePlatforms(f, ex);
          // Si matcheó por content_id, el filtro va por _id (permite que file_name
          // haya cambiado); si no había match previo, upsert por file_name como antes.
          const filter = ex ? { _id: (ex as any)._id } : { userId, file_name: f.file_name };
          return {
            updateOne: {
              filter,
              update: {
                $set: {
                  userId,
                  content_id:          f.content_id          ?? ex?.content_id ?? null,
                  file_name:           f.file_name,
                  platforms,
                  platforms_discarded,
                  content_status:      f.content_status      ?? 'borrador',
                  scheduled_date:      f.scheduled_date      ?? null,
                  duracion_segundos:   f.duracion_segundos   ?? null,
                  resolucion:          f.resolucion          ?? null,
                  formato:             f.formato             ?? null,
                  fecha_creacion:      f.fecha_creacion      ?? null,
                  local_updated_at:    new Date(f.local_updated_at),
                },
              },
              upsert: true,
            },
          };
        }),
      );
    }

    // ── Sincroniza también la colección `files` (FileModel) ────────────────────
    // Es la que leen TODOS los endpoints remotos (catálogo, slim, calendario).
    // Sin esto el remoto queda congelado en el scan viejo. Upsert por
    // {userId, file_name}: conserva el _id (y los enlaces a transcripts/platformvideos).
    // Misma protección: platforms vacío nunca pisa uno ya poblado en FileModel.
    const fileModelExisting = await FileModel.find(
      { userId, file_name: { $in: fileNames } },
      { file_name: 1, platforms: 1, platforms_discarded: 1 },
    ).lean();
    const fileModelExistingMap = new Map(fileModelExisting.map(e => [e.file_name, e]));

    await FileModel.bulkWrite(
      incoming.map(f => {
        const ex = fileModelExistingMap.get(f.file_name);
        const { platforms, platforms_discarded } = resolvePlatforms(f, ex as any);
        return {
          updateOne: {
            filter: { userId, file_name: f.file_name },
            update: {
              $set: {
                platforms,
                platforms_discarded,
                content_status:      f.content_status      ?? 'borrador',
                scheduled_date:      f.scheduled_date      ?? null,
                duracion_segundos:   f.duracion_segundos   ?? null,
                resolucion:          f.resolucion          ?? null,
                formato:             f.formato             ?? null,
                fecha_creacion:      f.fecha_creacion      ?? null,
              },
              // Solo al crear: campos requeridos que la app no envía (el remoto no
              // hace stream, así que file_path es un placeholder).
              $setOnInsert: { userId, file_name: f.file_name, file_path: f.file_name, status: 'PENDIENTE' },
            },
            upsert: true,
          },
        };
      }),
    );

    // Revivir: un archivo que vuelve en el push pero estaba archivado se reactiva.
    // Hace el sync autocorrectivo (un push parcial previo no deja nada perdido).
    await FileModel.updateMany(
      { userId, file_name: { $in: fileNames }, status: 'ELIMINADO_DISCO' },
      { $set: { status: 'PENDIENTE' } },
    );

    // ── Sincroniza a Nube (remote_library_videos) lo que se resolvió acá ──────
    // Publicar desde el desktop (subida real o "Editar links de plataforma" en
    // Videos) actualizaba `files`/`backup_files`, pero nunca tocaba Nube -- un
    // video vinculado ahí (bajado alguna vez al celular) nunca se enteraba de
    // que se publicó desde la PC. Solo para cuentas con storage en la nube
    // (mismo gate que requireCloudStorage), y solo lo NUEVO respecto a lo que
    // ya había en FileModel antes de este push (no todo lo que llegó).
    const canUseCloudStorage = isOwner(req.user!.username)
      || (req.user!.tier === 'premium' && req.user!.hasCloudStorage === true);
    if (canUseCloudStorage) {
      const newlyPublished = incoming
        .map(f => {
          const ex = fileModelExistingMap.get(f.file_name);
          const { platforms } = resolvePlatforms(f, ex as any);
          const previous = new Set(ex?.platforms ?? []);
          const added = platforms.filter((p: string) => !previous.has(p));
          return added.length > 0 ? { fileName: f.file_name, added } : null;
        })
        .filter((entry): entry is { fileName: string; added: string[] } => entry !== null);

      if (newlyPublished.length > 0) {
        const remoteVideos = await RemoteLibraryVideoModel.find(
          { userId, fileName: { $in: newlyPublished.map(n => n.fileName) } },
          { fileName: 1, platforms: 1, platformsDiscarded: 1 },
        ).lean();
        const remoteMap = new Map(remoteVideos.map(v => [v.fileName, v]));

        const remoteOps = newlyPublished
          .map(n => {
            const remote = remoteMap.get(n.fileName);
            if (!remote) return null; // este video nunca estuvo en Nube, nada que sincronizar
            const platforms = new Set(remote.platforms ?? []);
            n.added.forEach((p: string) => platforms.add(p));
            const platformsDiscarded = (remote.platformsDiscarded ?? []).filter((p: string) => !platforms.has(p));
            return {
              updateOne: {
                filter: { _id: remote._id },
                update: { $set: { platforms: Array.from(platforms), platformsDiscarded } },
              },
            };
          })
          .filter((op): op is NonNullable<typeof op> => op !== null);

        if (remoteOps.length > 0) await RemoteLibraryVideoModel.bulkWrite(remoteOps);
      }
    }

    // Reconciliación: si el push es completo (fullSync), lo que ya no está local
    // se marca ELIMINADO_DISCO en el central (los endpoints remotos lo excluyen).
    // No se borra físico → se preservan transcripts/platformvideos enlazados.
    let archived = 0;
    if (req.body.fullSync === true) {
      const r = await FileModel.updateMany(
        { userId, file_name: { $nin: fileNames }, status: { $ne: 'ELIMINADO_DISCO' } },
        { $set: { status: 'ELIMINADO_DISCO' } },
      );
      archived = r.modifiedCount ?? 0;

      // Mismo criterio para BackupFileModel -- a diferencia de FileModel, acá SÍ
      // se borra físico: nada referencia su _id (sin transcripts/platformvideos
      // enlazados, es solo el catálogo de solo-lectura que consume GET /api/
      // backup/files, ver LibraryListItem.BackupCatalog en Android), así que no
      // hay nada que preservar con un soft-delete. Sin esto, un video borrado en
      // el escritorio quedaba como fantasma para siempre en ese catálogo.
      await BackupFileModel.deleteMany({ userId, file_name: { $nin: fileNames } });
    }

    const { video_folder } = req.body;
    if (video_folder && typeof video_folder === 'string') {
      await UserModel.findByIdAndUpdate(userId, { video_folder });
    }

    res.json({ updated: toUpdate.length, skipped: incoming.length - toUpdate.length, filesSynced: incoming.length, archived });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/backup/transcripts
export async function getBackupTranscripts(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const transcripts = await TranscriptBackupModel.find(
      { userId },
      { file_name: 1, transcript_text: 1, language: 1 },
    ).lean();

    const result = transcripts.map(t => ({
      file_name:       t.file_name,
      transcript_text: t.transcript_text,
      language:        t.language ?? 'es',
    }));

    res.json({ transcripts: result, total: result.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/backup/transcripts/bulk
// Espejo real de las transcripciones locales — sin esto, el wipe de datos locales
// al cerrar sesión las borraba sin ninguna copia posible (ver getBackupTranscripts).
export async function bulkUpsertBackupTranscripts(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const incoming: any[] = req.body.transcripts;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      res.json({ ok: true, updated: 0 });
      return;
    }

    await TranscriptBackupModel.bulkWrite(
      incoming
        .filter(t => t && t.file_name && t.transcript_text)
        .map(t => ({
          updateOne: {
            filter: { userId, file_name: t.file_name },
            update: { $set: { userId, file_name: t.file_name, transcript_text: t.transcript_text, language: t.language ?? 'es' } },
            upsert: true,
          },
        })),
    );

    res.json({ ok: true, updated: incoming.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/backup/ideas-centrales
// Trae las ideas agrupadas (Mongo, legado) resolviendo file_id → file_name para que
// el local-backend pueda matchear contra su propia tabla `files` por nombre.
export async function getBackupIdeas(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const ideas = await IdeaCentral.find({ userId }).lean();

    const allFileIds = new Set<string>();
    for (const idea of ideas) {
      for (const v of idea.videos_vinculados ?? []) allFileIds.add(String(v.file_id));
    }
    const files   = await FileModel.find({ _id: { $in: Array.from(allFileIds) }, userId }, { _id: 1, file_name: 1 }).lean();
    const nameMap = new Map(files.map(f => [String(f._id), f.file_name]));

    const result = ideas
      .map(idea => ({
        idea_nucleo:          idea.idea_nucleo,
        resumen_visual:       idea.resumen_visual,
        status:               (idea as any).status ?? 'borrador',
        video_principal_name: nameMap.get(String(idea.video_principal_id)) ?? null,
        videos: (idea.videos_vinculados ?? [])
          .map(v => ({
            file_name:       nameMap.get(String(v.file_id)),
            similitud_guion: v.similitud_guion ?? 0,
            rol:             v.rol ?? 'RELACIONADO',
          }))
          .filter(v => v.file_name),
      }))
      .filter(idea => idea.videos.length > 0);

    res.json({ ideas: result, total: result.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/backup/config — preferencias de instalación (workflow_mode) + colas de calendario
export async function getBackupConfig(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const doc = await BackupConfigModel.findOne({ userId }).lean();
    res.json({
      workflow_mode:    doc?.workflow_mode ?? null,
      platform_configs: doc?.platform_configs ?? [],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/backup/config
export async function upsertBackupConfig(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { workflow_mode, platform_configs } = req.body as {
      workflow_mode?: string | null;
      platform_configs?: unknown[];
    };
    await BackupConfigModel.updateOne(
      { userId },
      {
        $set: {
          ...(workflow_mode !== undefined ? { workflow_mode } : {}),
          ...(Array.isArray(platform_configs) ? { platform_configs } : {}),
        },
      },
      { upsert: true },
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/backup/platform-videos
// Espejo del vínculo real archivo↔publicación (platform_videos local). A diferencia de
// files.platforms (solo un flag por plataforma), acá se conserva el platform_id/URL/fecha
// exactos, que el wipe de logout borra de SQLite sin dejar copia local.
export async function getBackupPlatformVideos(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const videos = await BackupPlatformVideoModel.find({ userId }).lean();
    res.json({ videos, total: videos.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/backup/platform-videos/bulk
export async function bulkUpsertBackupPlatformVideos(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const incoming: any[] = req.body.videos;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      res.json({ ok: true, updated: 0 });
      return;
    }

    await BackupPlatformVideoModel.bulkWrite(
      incoming
        .filter(v => v && v.platform && v.platform_id)
        .map(v => ({
          updateOne: {
            filter: { userId, platform: v.platform, platform_id: v.platform_id },
            update: {
              $set: {
                userId,
                platform:         v.platform,
                platform_id:      v.platform_id,
                platform_url:     v.platform_url    ?? null,
                published_at:     v.published_at    ?? null,
                file_name:        v.file_name       ?? null,
                content_id:       v.content_id      ?? null,
                match_status:     v.match_status    ?? 'sin_match',
                title:            v.title           ?? null,
                description:      v.description     ?? null,
                local_updated_at: new Date(v.local_updated_at),
              },
            },
            upsert: true,
          },
        })),
    );

    res.json({ ok: true, updated: incoming.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// Espeja un evento de publicación en BackupPlatformVideoModel -- la colección que
// lee el pull del PC (pullPlatformVideosFromCloud en local-backend), distinta de
// PlatformVideoModel (usada por Sincronizar/cross-match). Sin este upsert, publicar
// desde cualquier lado que no sea el PC (celular, "modo remoto") actualizaba el
// badge en FileModel.platforms (eso sí llega al PC vía pullFromCloud), pero el link
// real nunca aparecía ahí: el PC solo consulta backup_platform_videos. Usado por
// recordUploadEvent y por los uploadToX de youtube/instagram/tiktok-upload.controller.
export async function mirrorPlatformVideoToBackup(userId: string, data: {
  platform: string;
  platformId: string | null | undefined;
  platformUrl?: string | null;
  publishedAt?: Date;
  fileName?: string | null;
  contentId?: string | null;
  matchStatus?: string;
  title?: string | null;
}): Promise<void> {
  if (!data.platformId) return;
  await BackupPlatformVideoModel.updateOne(
    { userId, platform: data.platform, platform_id: data.platformId },
    {
      $set: {
        userId, platform: data.platform, platform_id: data.platformId,
        platform_url:     data.platformUrl ?? null,
        published_at:     data.publishedAt ?? new Date(),
        file_name:        data.fileName  ?? null,
        content_id:       data.contentId ?? null,
        match_status:     data.matchStatus ?? 'manual',
        title:            data.title ?? null,
        local_updated_at: new Date(),
      },
    },
    { upsert: true },
  );
}

// Actualiza platform_config (la colección que lee getCalendarConfig, ver
// sync.controller.ts) tras una publicación real que NO pasó por el PC --
// mismo efecto que syncNextVideoToCentral (local-backend/services/calendar-sync.service.ts)
// dispara después de cada subida de escritorio. Sin esto, el Calendario solo
// avanzaba "lastPublished"/"próximo" cuando se publicaba desde el escritorio:
// publicar desde el celular dejaba esos campos congelados en lo último que
// mandó el PC (o vacíos, si nunca se publicó desde ahí). "Próximo" replica
// findNewerAdjacent en local-backend/db/file.repo.ts: el primer archivo activo
// con fecha_creacion posterior al recién publicado que TODAVÍA no está
// resuelto (ni publicado ni descartado) para esta plataforma puntual -- sin
// ese filtro, un archivo ya publicado por otra vía (ej. directo desde
// Biblioteca remota, que no pasa por acá) dejaba el puntero pegado ahí para
// siempre en vez de saltarlo.
async function syncCalendarAfterPublish(
  userId: string,
  platform: string,
  publishedFile: { _id: any; file_name: string; fecha_creacion?: Date | null } | null,
): Promise<void> {
  if (!publishedFile || !['youtube', 'instagram', 'tiktok'].includes(platform)) return;
  try {
    const ref = publishedFile.fecha_creacion ?? new Date(0);
    const nextFile = await FileModel.findOne({
      userId,
      _id: { $ne: publishedFile._id },
      status: { $ne: 'ELIMINADO_DISCO' },
      content_status: { $ne: 'descartado' },
      fecha_creacion: { $gt: ref },
      platforms: { $ne: platform },
      platforms_discarded: { $ne: platform },
    }).sort({ fecha_creacion: 1, _id: 1 }).select('file_name').lean();

    const db = (await import('mongoose')).default.connection.db!;
    await db.collection('platform_config').updateOne(
      { userId, platform },
      {
        $set: {
          userId, platform,
          lastPublishedDate:  new Date().toISOString().slice(0, 10),
          lastPublishedTitle: publishedFile.file_name,
          lastVideoId:        String(publishedFile._id),
          nextVideoId:        nextFile?.file_name ?? null,
        },
      },
      { upsert: true },
    );
  } catch (err: any) {
    console.warn('[calendar] sync tras publish falló:', err.message);
  }
}

// Punto único que representa "esto se publicó de verdad en esta plataforma" --
// hasta hoy cada entry point (Sincronizar, subida real por celular/central,
// Editar links del escritorio, marcar publicado desde Nube) actualizaba un
// subconjunto DISTINTO de las colecciones involucradas, así que el mismo video
// podía terminar con el link en un lado y no en otro, el badge sin el link, o
// el Calendario sin enterarse. Esta función es la única fuente de verdad:
// llamarla es "esto quedó publicado", y deja consistentes:
//   - PlatformVideoModel (Sincronizar/Estadísticas)
//   - FileModel.platforms (el badge que se ve en Videos/Nube/todos lados)
//   - BackupPlatformVideoModel (lo que lee el pull del PC)
//   - platform_config (el Calendario)
//   - RemoteLibraryVideoModel, si el video también vive en Biblioteca remota
export async function applyPlatformPublish(userId: string, data: {
  platform: string;
  // string | null | undefined: algunos callers (ej. googleapis' response.data.id)
  // tipan el id como potencialmente ausente -- igual que mirrorPlatformVideoToBackup.
  platformId: string | null | undefined;
  platformUrl?: string | null;
  fileName?: string | null;
  contentId?: string | null;
  title?: string | null;
  publishedAt?: Date;
  matchStatus?: string;
}): Promise<{ linkedFileId: any | null }> {
  if (!data.platformId) return { linkedFileId: null };
  // any: llega de request bodies (recordUploadEvent, confirmLink, uploaders)
  // que ya validan el valor contra su propia lista de plataformas antes de
  // llegar acá -- este helper es compartido por varios callers con sus
  // propios union types (Platform, SyncPlatform, RemotePlatform), ninguno
  // 100% igual entre sí.
  const platform = data.platform as any;
  const platformId = data.platformId;
  const { platformUrl, fileName, contentId, title } = data;
  const publishedAtDate = data.publishedAt ?? new Date();
  const matchStatus = data.matchStatus ?? 'manual';

  let linkedFileId: any = null;
  let publishedFile: { _id: any; file_name: string; fecha_creacion?: Date | null } | null = null;
  if (fileName) {
    let file = contentId
      ? await FileModel.findOne({ userId, content_id: contentId })
      : await FileModel.findOne({ userId, file_name: fileName });
    // Si no hay ningún archivo local con ese nombre (ej. video publicado
    // directo desde el celular, sin pasar antes por el catálogo), se crea un
    // registro mínimo -- si no, Estadísticas (getGroupStats) no tiene de
    // dónde sacarlo y queda sin ver el video hasta que alguien lo vincule a
    // mano en Videos (escritorio).
    if (!file) {
      file = await FileModel.findOneAndUpdate(
        { userId, file_name: fileName },
        { $setOnInsert: { userId, file_name: fileName, file_path: fileName, status: 'PENDIENTE' } },
        { upsert: true, new: true },
      );
    }
    linkedFileId = file._id;
    if (!file.platforms.includes(platform)) {
      await FileModel.updateOne(
        { _id: file._id },
        { $addToSet: { platforms: platform }, $pull: { platforms_discarded: platform } },
      );
    }
    publishedFile = { _id: file._id, file_name: file.file_name, fecha_creacion: file.fecha_creacion };
  }

  await PlatformVideoModel.updateOne(
    { userId, platform, platformId },
    {
      $set: {
        userId, platform, platformId,
        platformUrl:  platformUrl ?? '',
        title:        title ?? '',
        publishedAt:  publishedAtDate,
        linkedFileId,
        matchStatus,
        lastSyncedAt: new Date(),
      },
    },
    { upsert: true },
  );

  await mirrorPlatformVideoToBackup(userId, {
    platform, platformId, platformUrl, fileName, contentId, title,
    publishedAt: publishedAtDate, matchStatus,
  });

  await syncCalendarAfterPublish(userId, platform, publishedFile);

  // E: si el mismo video (por fileName o contentId) también vive en Biblioteca
  // remota, refleja la plataforma ahí también -- solo altas, nunca desvincula
  // ni descarta desde acá (mismo criterio conservador que bulkUpsertBackupFiles
  // usa para no pisar decisiones tomadas directamente en Nube). RemoteLibraryVideoModel
  // no tiene 'facebook' en su enum de plataformas (solo youtube/instagram/tiktok).
  if ((fileName || contentId) && ['youtube', 'instagram', 'tiktok'].includes(platform)) {
    try {
      const remoteQuery = contentId ? { userId, contentId } : { userId, fileName };
      const remote = await RemoteLibraryVideoModel.findOne(remoteQuery as any);
      if (remote && !remote.platforms.includes(platform as any)) {
        const keptLinks = (remote.platformLinks ?? []).filter((l) => l.platform !== platform);
        await RemoteLibraryVideoModel.updateOne(
          { _id: remote._id },
          {
            $addToSet: { platforms: platform },
            $pull: { platformsDiscarded: platform },
            $set: { platformLinks: [...keptLinks, { platform, platformId, platformUrl: platformUrl ?? '', publishedAt: publishedAtDate }] },
          },
        );
      }
    } catch (err: any) {
      console.warn('[applyPlatformPublish] sync a Biblioteca remota falló:', err.message);
    }
  }

  return { linkedFileId };
}

// POST /api/sync/history (alias: /api/sync/record-publish, ver sync.routes.ts) —
// registra UN evento de subida confirmada, en el momento exacto en que pasa
// (llamado desde cada upload controller local, y desde UploadCoordinator en iOS,
// justo después de publicar). A diferencia del push de backup (que manda el
// catálogo completo y puede tardar/fallar/quedar flaco tras un wipe), esto es un
// insert puntual e inmediato -- por eso sobrevive cualquier wipe local sin
// depender de él.
//
// Además de loguear el evento (UploadHistoryModel), delega en applyPlatformPublish
// -- sin esto, FileModel/PlatformVideoModel/el Calendario/Nube quedaban
// desactualizados para todo lo publicado fuera del flujo viejo de
// youtube/instagram/tiktok-upload.controller.ts (ej. subidas desde el celular).
// deviceId es opcional: iOS todavía no lo manda en record-publish.
export async function recordUploadEvent(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { deviceId, platform, platformId, platformUrl, fileName, contentId, title, publishedAt } = req.body ?? {};
    if (!platform || !platformId) {
      res.status(400).json({ message: 'platform y platformId son requeridos.' });
      return;
    }
    const publishedAtDate = publishedAt ? new Date(publishedAt) : new Date();

    await UploadHistoryModel.updateOne(
      { userId, platform, platformId },
      {
        $set: {
          userId, platform, platformId,
          deviceId:    deviceId    ?? 'desconocido',
          platformUrl: platformUrl ?? null,
          fileName:    fileName    ?? null,
          contentId:   contentId   ?? null,
          title:       title       ?? null,
          publishedAt: publishedAtDate,
        },
      },
      { upsert: true },
    );

    await applyPlatformPublish(userId, {
      platform, platformId, platformUrl, fileName, contentId, title,
      publishedAt: publishedAtDate, matchStatus: 'manual',
    });

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/sync/history?limit=&offset=&platform= — universal (mismo endpoint que
// local-backend/src/controllers/sync.controller.ts::getUploadHistory), para que
// Historial se vea igual desde Android/web remoto que desde el escritorio: ahí no
// hay SQLite local, así que se sirve de UploadHistoryModel (el log de eventos que
// escribe recordUploadEvent) en vez de la tabla platform_videos.
export async function getUploadHistory(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const limit  = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const platform = ['youtube', 'tiktok', 'instagram', 'facebook'].includes(req.query.platform as string)
      ? (req.query.platform as string)
      : undefined;

    const query: Record<string, unknown> = { userId };
    if (platform) query.platform = platform;

    const [total, docs] = await Promise.all([
      UploadHistoryModel.countDocuments(query),
      UploadHistoryModel.find(query)
        .sort({ publishedAt: -1, createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
    ]);

    const items = docs.map((h: any) => ({
      id:           String(h._id),
      platform:     h.platform,
      platformId:   h.platformId,
      platformUrl:  h.platformUrl ?? null,
      publishedAt:  h.publishedAt ?? h.createdAt,
      title:        h.title ?? null,
      fileName:     h.fileName ?? null,
      deviceId:     h.deviceId ?? null,
      linkedFileId: null, // concepto local (id de SQLite) -- no aplica en modo remoto
      matchStatus:  'manual',
    }));

    res.json({ items, total });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
}

// GET /api/backup/sync-status?contentIds=a,b,c
// Dado un set de content_id (identidad estable del video, ver files.content_id en
// SQLite local), responde por cada uno si hay metadata respaldada (backup_files) y/o
// bytes reales en la Biblioteca remota (remote_library_videos). Es el mínimo necesario
// para que el frontend pueda mostrar "en la nube ✓ / solo local" sin cruzar todo a mano.
export async function getSyncStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const raw = typeof req.query.contentIds === 'string' ? req.query.contentIds : '';
    const contentIds = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (contentIds.length === 0) {
      res.status(400).json({ error: 'contentIds requerido (query string separada por comas)' });
      return;
    }

    const [backedUp, inRemoteLibrary] = await Promise.all([
      BackupFileModel.find({ userId, content_id: { $in: contentIds } }, { content_id: 1 }).lean(),
      // storedFileName != null -- si no, "en la nube" quedaba en true para
      // siempre aunque el almacenamiento dinámico ya haya liberado los bytes
      // (ver remote-library-retention.service.ts): el doc/miniatura sobreviven
      // a propósito, pero eso ya no es "hay bytes reales en la nube".
      RemoteLibraryVideoModel.find({ userId, contentId: { $in: contentIds }, storedFileName: { $ne: null } }, { contentId: 1 }).lean(),
    ]);
    const backedUpSet = new Set(backedUp.map(f => f.content_id));
    const remoteSet = new Set(inRemoteLibrary.map(v => v.contentId));

    const status = contentIds.map(id => ({
      contentId: id,
      metadataBackedUp: backedUpSet.has(id),
      inRemoteLibrary: remoteSet.has(id),
    }));

    res.json({ status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/backup/status
export async function getBackupStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const total  = await BackupFileModel.countDocuments({ userId });
    const latest = await BackupFileModel.findOne({ userId }, { updatedAt: 1 })
      .sort({ updatedAt: -1 }).lean();
    res.json({ total, lastSync: latest ? (latest as any).updatedAt : null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
