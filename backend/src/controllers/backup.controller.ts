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
    const [allFiles, user] = await Promise.all([
      BackupFileModel.find({ userId }).lean(),
      UserModel.findById(userId, { video_folder: 1 }).lean(),
    ]);
    const files = includeResolved
      ? allFiles
      : allFiles.filter(f => (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0) < 3);
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
    const existing = await BackupFileModel.find(
      { userId, file_name: { $in: fileNames } },
      { file_name: 1, local_updated_at: 1, platforms: 1, platforms_discarded: 1 },
    ).lean();
    const existingMap = new Map(existing.map(e => [e.file_name, e]));

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
      const ex = existingMap.get(f.file_name);
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
          const ex = existingMap.get(f.file_name);
          const { platforms, platforms_discarded } = resolvePlatforms(f, ex);
          return {
            updateOne: {
              filter: { userId, file_name: f.file_name },
              update: {
                $set: {
                  userId,
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
