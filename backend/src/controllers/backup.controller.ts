import { Response } from 'express';
import { AuthRequest, isOwner } from '../middleware/auth.middleware';
import { BackupFileModel } from '../models/backup-file.model';
import { TranscriptBackupModel } from '../models/transcript-backup.model';
import { FileModel, Platform } from '../models/file.model';
import { UserModel } from '../models/user.model';
import { IdeaCentral } from '../models/ideaCentral';
import { BackupConfigModel } from '../models/backup-config.model';
import { BackupPlatformVideoModel } from '../models/backup-platform-video.model';
import { RemoteLibraryVideoModel, RemotePlatform } from '../models/remote-library-video.model';
import { UploadHistoryModel } from '../models/upload-history.model';
import { PlatformVideoModel } from '../models/platform-video.model';
import { recordAuditEvent } from '../services/audit.service';
import { getVideoPublishedAt as getYoutubePublishedAt } from '../services/youtube.service';
import { getMediaPublishedAt as getInstagramPublishedAt } from '../services/instagram.service';
import { getVideoPublishedAt as getTiktokPublishedAt } from '../services/tiktok.service';
import { upsertConfirmed, deriveStatesFromToggle } from '../utils/platform-state.util';
import { errorName, logger } from '../utils/logger';

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
      FileModel.find({ userId }).select('file_name platforms platforms_discarded platform_states content_status scheduled_date duracion_segundos resolucion formato fecha_creacion updatedAt').lean(),
    ]);

    const centralByName = new Map(centralFiles.map(f => [f.file_name, f]));
    const backupNames = new Set(allFiles.map(f => f.file_name));
    const enriched = allFiles.map(f => {
      const current = (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0);
      const central = centralByName.get(f.file_name);
      // BUG-2026-08-15-03: platform_states vive solo en FileModel (central) --
      // BackupFileModel (de donde sale `f`) nunca tuvo el concepto de
      // confirmed/badge_only, así que siempre hay que traerlo de acá cuando
      // exista un match central, sin importar si platforms/platforms_discarded
      // ya coincidían (esa comparación de abajo es para decidir si hace falta
      // pisar los arrays planos, no para esto).
      const platform_states = central?.platform_states ?? (f as any).platform_states;
      if (current >= 3) return { ...f, platform_states };
      if (!central) return { ...f, platform_states };
      const centralPlatforms = [...(central.platforms ?? [])].sort().join('|');
      const currentPlatforms = [...(f.platforms ?? [])].sort().join('|');
      const centralDiscarded = [...(central.platforms_discarded ?? [])].sort().join('|');
      const currentDiscarded = [...(f.platforms_discarded ?? [])].sort().join('|');
      if (centralPlatforms === currentPlatforms && centralDiscarded === currentDiscarded) {
        return { ...f, platform_states };
      }
      // El pull del cliente compara local_updated_at antes de aplicar el
      // badge. Si devolvemos la marca vieja de BackupFileModel, Electron
      // puede recibir el enlace de PlatformVideo pero descartar el badge.
      return {
        ...f,
        platforms: central.platforms ?? f.platforms,
        platforms_discarded: central.platforms_discarded ?? f.platforms_discarded,
        platform_states,
        local_updated_at: (central as any).updatedAt ?? f.local_updated_at,
      };
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
        // FIX 2026-08-16: faltaban _id y createdAt acá -- este objeto nunca
        // pasaba por BackupFileModel (de ahí "onlyInCentral"), así que no
        // tenía ninguno de los dos. El desktop (pullFromCloud) matchea por
        // file_name y nunca los necesitó, pero BackupFileDTO.swift en iOS
        // los exige NO opcionales -- con cualquier archivo así en la lista,
        // el decode de TODO el array fallaba ("no se pudo leer la respuesta
        // del servidor"), igual que el bug de 'facebook' (BUG-2026-08-16-02)
        // pero por un campo faltante en vez de un valor de enum inesperado.
        _id:                 f._id,
        createdAt:           f.fecha_creacion ?? (f as any).updatedAt ?? new Date(),
        file_name:           f.file_name,
        platforms:           f.platforms           ?? [],
        platforms_discarded: f.platforms_discarded ?? [],
        platform_states:     f.platform_states      ?? [],
        content_status:      f.content_status      ?? 'borrador',
        scheduled_date:      f.scheduled_date       ?? null,
        duracion_segundos:   f.duracion_segundos    ?? null,
        resolucion:          f.resolucion           ?? null,
        formato:             f.formato              ?? null,
        fecha_creacion:      f.fecha_creacion        ?? null,
        local_updated_at:    (f as any).updatedAt,
        // FileModel (de donde sale esta rama) no tiene platforms_updated_at
        // propio -- null es correcto acá, no una omisión: pullFromCloud ya
        // trata null como "sin LWW dedicado posible" y cae al criterio
        // histórico (converger a la nube), que es justo lo que corresponde
        // para un archivo que el dispositivo ni siquiera conocía todavía.
        platforms_updated_at: null,
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

    // Fase D de docs/primary-install-corrected-plan-2026-08-14.md (hallazgo
    // de seguridad #2): antes se confiaba ciegamente en el booleano fullSync
    // que mandaba el cliente -- cualquier instalación podía archivar el
    // catálogo de otra con solo mandar fullSync:true. Ahora la central
    // recalcula esto comparando deviceId contra User.primaryDeviceId; el
    // valor que mande el cliente en el body se ignora más abajo.
    //
    // Bootstrap de primaria (sin contraseña, a propósito -- ver "Resolución
    // del bootstrap" en el plan): si la cuenta todavía no tiene
    // primaryDeviceId, ESTA es la primera operación de catálogo real que
    // llega, y el dispositivo que la manda queda fijado como primaria acá
    // mismo, sin pedir confirmación (no hay nada que proteger todavía --
    // reemplazarla después SÍ exige POST /api/auth/claim-primary con
    // contraseña).
    //
    // FIX 2026-08-14 (condición de carrera encontrada en revisión post-Fase
    // D): la versión anterior hacía find() y DESPUÉS un update incondicional
    // -- si dos instalaciones nuevas mandaban su primer push casi al mismo
    // tiempo, las dos leían primaryDeviceId vacío, las dos se consideraban
    // "primaria" y las dos ejecutaban reconciliación (podían archivarse
    // catálogo una a la otra) antes de que cualquier escritura "ganara".
    // Ahora: updateOne con filtro condicional (solo aplica si SIGUE vacío en
    // el momento exacto de escribir, atómico a nivel de Mongo) + relectura
    // para saber quién ganó de verdad antes de decidir si reconciliar.
    const { deviceId } = req.body as { deviceId?: string };
    if (deviceId && deviceId.length >= 16) {
      await UserModel.updateOne(
        { _id: userId, primaryDeviceId: { $in: [null, undefined] } },
        { $set: { primaryDeviceId: deviceId } },
      );
    }
    const userDoc = await UserModel.findById(userId).select('primaryDeviceId').lean();
    // Cliente viejo/sin deviceId todavía: se sigue tratando como primaria
    // igual que antes de este cambio (no empeora nada, solo no participa del
    // bootstrap atómico). Log temporal para saber cuándo ya no quedan
    // clientes sin migrar y se puede exigir deviceId de verdad.
    if (!deviceId) console.warn(`[bulkUpsertBackupFiles] push sin deviceId (cliente sin migrar) -- userId=${userId}`);
    const isPrimary = !deviceId || !userDoc?.primaryDeviceId || userDoc.primaryDeviceId === deviceId;

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
      { file_name: 1, content_id: 1, local_updated_at: 1, platforms: 1, platforms_discarded: 1, platforms_updated_at: 1 },
    ).lean();
    const existingByFileName  = new Map(existing.map(e => [e.file_name, e]));
    const existingByContentId = new Map(existing.filter(e => e.content_id).map(e => [e.content_id as string, e]));
    const resolveExisting = (f: any) =>
      (f.content_id && existingByContentId.get(f.content_id)) || existingByFileName.get(f.file_name);

    // Para cada archivo entrante, decide si el valor de platforms que se aplica es
    // el que llegó (incoming) o el que ya había en la nube (protegido). Si se
    // protege, platforms_updated_at también se conserva (SYNC-01 #3) -- el
    // badge real no cambió con este push, así que pisar su timestamp con el
    // de un push que ni siquiera trae datos rompería el LWW dedicado.
    function resolvePlatforms(f: any, ex: typeof existing[number] | undefined) {
      const incomingEmpty = !hasData(f.platforms) && !hasData(f.platforms_discarded);
      const existingHasData = !!ex && (hasData(ex.platforms) || hasData(ex.platforms_discarded));
      if (incomingEmpty && existingHasData) {
        return {
          platforms: ex!.platforms, platforms_discarded: ex!.platforms_discarded,
          platforms_updated_at: (ex as any)!.platforms_updated_at ?? null,
          protected: true,
        };
      }
      return {
        platforms: f.platforms ?? [], platforms_discarded: f.platforms_discarded ?? [],
        platforms_updated_at: f.platforms_updated_at ? new Date(f.platforms_updated_at) : null,
        protected: false,
      };
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
      try {
        await BackupFileModel.bulkWrite(
          toUpdate.map(f => {
            const ex = resolveExisting(f);
            const { platforms, platforms_discarded, platforms_updated_at } = resolvePlatforms(f, ex);
            // Si matcheó por content_id, el filtro va por _id (permite que file_name
            // haya cambiado); si no había match previo, upsert por file_name como antes.
            const filter = ex ? { _id: (ex as any)._id } : { userId, file_name: f.file_name };
            return {
              updateOne: {
                filter,
                update: {
                  $set: {
                    userId,
                    // Preferí el content_id que YA tenía el documento por sobre el que
                    // trae este push -- si dos instalaciones del mismo usuario (dos PCs)
                    // matchean el mismo archivo por file_name, cada una genera su propio
                    // content_id local (randomUUID por instalación, ver database.ts), y
                    // dejar que el último push gane producía ping-pong sobre un campo que
                    // se supone estable. Una vez fijado, solo lo completa si faltaba
                    // (docs/mongo-remediation-review-2026-08-13.md, hallazgo H8).
                    content_id:          ex?.content_id ?? f.content_id ?? null,
                    file_name:           f.file_name,
                    platforms,
                    platforms_discarded,
                    platforms_updated_at,
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
          { ordered: false },
        );
      } catch (err: any) {
        // ordered:false ya aplicó todas las operaciones que no chocaron contra un
        // índice único -- no abortamos el resto del push (FileModel, Nube,
        // reconciliación) por un duplicado aislado. Antes esto tumbaba el backup
        // completo con un solo E11000 (hallazgo H7 de la revisión independiente).
        logger.warn('backup_files_bulk_partial_failure', {
          writeErrorCount: err.writeErrors?.length ?? null,
          errorName: errorName(err),
        });
      }
    }

    // ── Sincroniza también la colección `files` (FileModel) ────────────────────
    // Es la que leen TODOS los endpoints remotos (catálogo, slim, calendario) Y
    // applyPlatformPublish (el match por content_id de ahí dependía de esto --
    // antes FileModel nunca guardaba content_id, así que ese lookup nunca
    // encontraba nada y siempre caía a file_name). Mismo criterio que ya usa
    // BackupFileModel arriba: matchea por content_id (estable ante renombres)
    // o por file_name como fallback, y si matcheó por content_id el filtro va
    // por _id (permite que file_name haya cambiado sin perder los enlaces a
    // transcripts/platformvideos). Misma protección: platforms vacío nunca
    // pisa uno ya poblado en FileModel.
    const fileModelExisting = await FileModel.find(
      {
        userId,
        $or: [
          { file_name: { $in: fileNames } },
          ...(contentIds.length ? [{ content_id: { $in: contentIds } }] : []),
        ],
      },
      { file_name: 1, content_id: 1, platforms: 1, platforms_discarded: 1 },
    ).lean();
    const fileModelExistingByFileName  = new Map(fileModelExisting.map(e => [e.file_name, e]));
    const fileModelExistingByContentId = new Map(fileModelExisting.filter(e => e.content_id).map(e => [e.content_id as string, e]));
    const resolveFileModelExisting = (f: any) =>
      (f.content_id && fileModelExistingByContentId.get(f.content_id)) || fileModelExistingByFileName.get(f.file_name);

    try {
      await FileModel.bulkWrite(
        incoming.map(f => {
          const ex = resolveFileModelExisting(f);
          const { platforms, platforms_discarded } = resolvePlatforms(f, ex as any);
          const filter = ex ? { _id: (ex as any)._id } : { userId, file_name: f.file_name };
          return {
            updateOne: {
              filter,
              update: {
                $set: {
                  // Mismo criterio que BackupFileModel arriba: no reasignar un
                  // content_id ya fijado (H8 de la revisión independiente).
                  content_id:          ex?.content_id ?? f.content_id ?? null,
                  file_name:           f.file_name,
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
                $setOnInsert: { userId, file_path: f.file_name, status: 'PENDIENTE' },
              },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      );
    } catch (err: any) {
      // Mismo criterio que arriba: no abortar el resto del push por un duplicado
      // aislado (hallazgo H7).
      logger.warn('files_bulk_partial_failure', {
        writeErrorCount: err.writeErrors?.length ?? null,
        errorName: errorName(err),
      });
    }

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
          const ex = resolveFileModelExisting(f);
          const { platforms } = resolvePlatforms(f, ex as any);
          const previous = new Set<string>(ex?.platforms ?? []);
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
            const platforms = new Set<string>(remote.platforms ?? []);
            n.added.forEach((p: string) => platforms.add(p));
            const platformsDiscarded = (remote.platformsDiscarded ?? []).filter((p: string) => !platforms.has(p));
            return {
              updateOne: {
                filter: { _id: remote._id },
                update: { $set: {
                  platforms: Array.from(platforms) as RemotePlatform[],
                  platformsDiscarded: platformsDiscarded as RemotePlatform[],
                } },
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
    // isPrimary manda acá, no req.body.fullSync (ver comentario al principio).
    let archived = 0;
    if (isPrimary && req.body.fullSync === true) {
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

    // Configurar carpeta también queda gateado a la primaria (Fase 1 del plan
    // de instalación primaria) -- una secundaria no debe poder redefinir
    // dónde vive físicamente el catálogo de la cuenta.
    const { video_folder } = req.body;
    if (isPrimary && video_folder && typeof video_folder === 'string') {
      await UserModel.findByIdAndUpdate(userId, { video_folder });
    }

    res.json({
      updated: toUpdate.length, skipped: incoming.length - toUpdate.length,
      filesSynced: incoming.length, archived, isPrimary,
    });
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
    // Recuperación: una publicación móvil puede haber quedado registrada en
    // upload_history aunque el espejo backup_platform_videos fallara por una
    // caída breve. Reaplicar el evento es idempotente y reconstruye también el
    // badge en FileModel antes de que Electron haga el pull.
    //
    // PERO upload_history es un log PERMANENTE (nunca se borra ni se corrige) --
    // este endpoint lo pide el escritorio en cada sync tick (cada 5 min), así que
    // reaplicar TODO el historial sin condición revivía para siempre cualquier
    // link viejo/roto (ej. un id de YouTube mal pegado y borrado a mano después):
    // volvía a pisar el link bueno en el siguiente ciclo. Bug real confirmado en
    // producción con "final - detalle ddr5.mp4" (yDjFp89AnRQ resucitando cada 5
    // min sobre 3kh98K5qPZw). Ahora solo se reaplican los eventos que TODAVÍA no
    // tienen ningún PlatformVideoModel -- eso alcanza para la recuperación real
    // (mirror que nunca se creó) sin pisar una corrección posterior.
    //
    // Ese chequeo (match exacto por platformId) seguía roto para el caso más
    // común de corrección: cuando se corrige un platformId malo (ej. un
    // publish_id de TikTok que nunca fue el id real, ver tiktok-upload.controller.ts)
    // el documento viejo se BORRA -- entonces el historial viejo con el
    // platformId malo deja de matchear CUALQUIER PlatformVideoModel existente
    // y vuelve a verse "missing" para siempre, resucitando el dato malo cada
    // sync tick. Confirmado en producción el 2026-07-30 con dos videos
    // rompiéndose solos cada 5-15 min sin que ningún dispositivo hiciera nada.
    // Ahora también se descarta un evento de historial si YA existe un
    // PlatformVideoModel para ese mismo platform+fileName (con OTRO
    // platformId) -- eso significa que alguien ya lo resolvió después.
    //
    // El match por fileName es ambiguo si dos archivos DISTINTOS del mismo
    // usuario comparten nombre exacto (raro, pero posible) -- por eso se
    // prefiere content_id (identidad estable, inmune a esa colisión) cuando
    // está disponible tanto en el historial como en FileModel, y fileName
    // queda de fallback para registros viejos que no lo tienen.
    const history = await UploadHistoryModel.find({ userId }).lean();
    const existing = await PlatformVideoModel.find({
      userId,
      platform: { $in: [...new Set(history.map((h: any) => h.platform))] },
    }).select('platform platformId linkedFileId').lean();
    const existingIdKeys = new Set(existing.map((pv) => `${pv.platform}:${pv.platformId}`));
    const linkedFileIds = existing.map((pv) => pv.linkedFileId).filter(Boolean);
    const linkedFiles = linkedFileIds.length
      ? await FileModel.find({ _id: { $in: linkedFileIds } }).select('file_name content_id').lean()
      : [];
    const fileNameById = new Map(linkedFiles.map((f) => [String(f._id), f.file_name]));
    const contentIdById = new Map(linkedFiles.filter((f) => f.content_id).map((f) => [String(f._id), f.content_id as string]));
    const existingFileKeys = new Set(
      existing
        .filter((pv) => pv.linkedFileId && fileNameById.has(String(pv.linkedFileId)))
        .map((pv) => `${pv.platform}:${fileNameById.get(String(pv.linkedFileId))}`),
    );
    const existingContentIdKeys = new Set(
      existing
        .filter((pv) => pv.linkedFileId && contentIdById.has(String(pv.linkedFileId)))
        .map((pv) => `${pv.platform}:${contentIdById.get(String(pv.linkedFileId))}`),
    );
    const missing = history.filter((h: any) => {
      if (existingIdKeys.has(`${h.platform}:${h.platformId}`)) return false;
      if (h.contentId && existingContentIdKeys.has(`${h.platform}:${h.contentId}`)) return false;
      if (h.fileName && existingFileKeys.has(`${h.platform}:${h.fileName}`)) return false;
      return true;
    });
    await Promise.all(missing.map((h: any) => applyPlatformPublish(userId, {
      platform: h.platform,
      platformId: h.platformId,
      platformUrl: h.platformUrl,
      fileName: h.fileName,
      contentId: h.contentId,
      title: h.title,
      deviceId: h.deviceId,
      source: h.source,
      publishedAt: h.publishedAt,
      matchStatus: 'manual',
    })));
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
                device_id:        v.device_id       ?? null,
                source:           v.source           ?? null,
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
  remoteLibraryVideoId?: string | null;
  deviceId?: string | null;
  source?: string | null;
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
        device_id:        data.deviceId ?? null,
        source:           data.source ?? null,
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
  platform: Platform,
  publishedFile: { _id: any; file_name: string; fecha_creacion?: Date | null } | null,
  publishedAt: Date,
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
    // nextRemoteLibraryVideoId apunta a los BYTES ya precargados del "próximo"
    // anterior -- si acá "próximo" cambia de archivo y no se invalida, queda
    // apuntando a un video que ya no es el próximo real. ensurePreloadForNextVideos
    // (local-backend/calendar-sync.service.ts) interpreta "viene con un id" como
    // "ya está precargado" y nunca vuelve a intentarlo: Biblioteca remota se
    // queda sin el archivo correcto para siempre (bug real confirmado: los 3
    // platform_config quedaron con IDs de precarga huérfanos, apuntando a
    // documentos que ya no existen).
    const current = await db.collection('platform_config').findOne({ userId, platform }, { projection: { nextVideoId: 1 } });
    const newNextVideoId = nextFile?.file_name ?? null;
    const nextChanged = (current?.nextVideoId ?? null) !== newNextVideoId;

    await db.collection('platform_config').updateOne(
      { userId, platform },
      {
        $set: {
          userId, platform,
          // Debe ser la fecha real del evento, no la hora en la que esta
          // sincronización llegó al servidor. De otro modo un backfill o un
          // reintento tardío puede hacer que Calendario muestre un video viejo
          // como el último publicado, aunque Historial esté correcto.
          lastPublishedDate:  publishedAt.toISOString().slice(0, 10),
          lastPublishedTitle: publishedFile.file_name,
          lastVideoId:        String(publishedFile._id),
          nextVideoId:        newNextVideoId,
          ...(nextChanged ? { nextRemoteLibraryVideoId: null } : {}),
        },
      },
      { upsert: true },
    );
  } catch (err: any) {
    logger.warn('calendar_sync_after_publish_failed', { errorName: errorName(err) });
  }
}

// Resuelve (o crea, si no existe todavía) el FileModel correspondiente a un
// archivo local -- por content_id (estable ante renombres/reimportado en otro
// dispositivo) o file_name como fallback, con el mismo criterio de búsqueda
// case-insensitive y de resolver por Biblioteca remota si hace falta.
// Extraído de applyPlatformPublish para reusar exactamente la misma lógica de
// matching desde updateFilePlatforms (descartar, ver abajo) -- antes solo
// "publicar" llegaba a la central; "descartar" desde iOS/Android era 100%
// local y nunca resolvía ni tocaba este mismo archivo.
async function resolveOrCreateFile(
  userId: string,
  data: { fileName?: string | null; contentId?: string | null; remoteLibraryVideoId?: string | null },
) {
  const { fileName, contentId, remoteLibraryVideoId } = data;
  if (!fileName) return null;
  const remote = remoteLibraryVideoId
    ? await RemoteLibraryVideoModel.findOne({ _id: remoteLibraryVideoId, userId })
        .select('contentId fileName')
        .lean()
    : null;
  const stableContentId = contentId ?? remote?.contentId;
  let file = stableContentId
    ? await FileModel.findOne({ userId, content_id: stableContentId })
    : await FileModel.findOne({ userId, file_name: fileName });
  if (!file) {
    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    file = await FileModel.findOne({ userId, file_name: { $regex: `^${escaped}$`, $options: 'i' } });
  }
  // El nombre puede cambiar al clonar/importar el video en otro dispositivo;
  // el ID de Biblioteca remota/contentId es la identidad real.
  if (!file && remote?.fileName && remote.fileName !== fileName) {
    file = await FileModel.findOne({ userId, file_name: remote.fileName });
  }
  // Si no hay ningún archivo local con ese nombre (ej. video publicado/
  // descartado directo desde el celular, sin pasar antes por el catálogo),
  // se crea un registro mínimo -- si no, Estadísticas/el pull del PC no
  // tienen de dónde sacarlo y queda invisible hasta que alguien lo vincule a
  // mano en Videos (escritorio).
  if (!file) {
    // content_id acá también: sin esto, un archivo creado desde una publicación
    // móvil (sin catálogo previo en el escritorio) quedaba para siempre sin
    // content_id aunque el caller lo hubiera mandado -- fuera del índice único
    // parcial de identidad (H8 de la revisión independiente).
    const setOnInsert: Record<string, unknown> = { userId, file_name: fileName, file_path: fileName, status: 'PENDIENTE' };
    if (stableContentId) setOnInsert.content_id = stableContentId;
    file = await FileModel.findOneAndUpdate(
      { userId, file_name: fileName },
      { $setOnInsert: setOnInsert },
      { upsert: true, new: true },
    );
  }
  return file;
}

// POST /api/sync/file-platforms — sincroniza el estado COMPLETO de
// publicado/descartado por plataforma de un archivo hacia la central. Manda
// los arrays enteros (no un delta) -- mismo shape que ya usa
// RemoteLibraryAPI.updatePlatforms (iOS)/updatePlatforms (Android) para
// Biblioteca remota, así el caller (que ya tiene platforms/platformsDiscarded
// calculados localmente tras el toggle) no tiene que decidir $addToSet vs
// $pull, solo mandar el estado final.
//
// Hasta este endpoint, "publicar" SÍ llegaba a la central (recordUploadEvent
// -> applyPlatformPublish, más abajo) pero "descartar" era 100% local en
// SwiftData/Room -- solo sincronizaba a RemoteLibraryVideoModel si el archivo
// pasaba por Biblioteca remota. GET /api/backup/files ya mergea FileModel por
// encima de BackupFileModel (ver el comentario ahí, incidente de julio 2026),
// así que alcanza con escribir FileModel acá: el pull() de desktop ya sabe
// traer esto de vuelta a SQLite sin ningún cambio del lado del pull.
export async function updateFilePlatforms(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const { fileName, contentId, remoteLibraryVideoId, platforms, platformsDiscarded } = req.body ?? {};
    if (!fileName || !Array.isArray(platforms) || !Array.isArray(platformsDiscarded)) {
      res.status(400).json({ message: 'fileName, platforms[] y platformsDiscarded[] son requeridos.' });
      return;
    }
    const file = await resolveOrCreateFile(userId, { fileName, contentId, remoteLibraryVideoId });
    if (!file) {
      res.status(404).json({ message: 'No se pudo resolver el archivo.' });
      return;
    }
    // BUG-2026-08-15-03: este endpoint es un toggle "estado final completo",
    // sin link real -- todo lo que entra por acá es como mucho 'badge_only'.
    // deriveStatesFromToggle nunca degrada algo que ya estaba 'confirmed'
    // (publicado de verdad vía applyPlatformPublish).
    const newStates = deriveStatesFromToggle(file.platform_states ?? [], platforms, platformsDiscarded);
    await FileModel.updateOne(
      { _id: file._id },
      { $set: { platforms, platforms_discarded: platformsDiscarded, platform_states: newStates } },
    );
    res.json({ ok: true, fileId: file._id });

    // Simétrico al fix de BUG-2026-08-15-03 que ya propaga descartes hechos en
    // Nube hacia FileModel (updateRemoteLibraryVideoPlatforms, commit
    // 31737c9) -- hasta acá, un descarte hecho DESDE este endpoint (mobile,
    // "Editar links" de escritorio) nunca viajaba en la otra dirección, así
    // que un video con badges divergentes entre Nube y el catálogo central
    // podía volver a divergir apenas alguien tocara el lado central. Mismo
    // criterio conservador: nunca pisa una plataforma que Nube ya tiene como
    // badge/confirmada real.
    const beforeDiscarded: string[] = file.platforms_discarded ?? [];
    const newlyDiscarded: string[] = platformsDiscarded.filter(
      (p: string) => !beforeDiscarded.includes(p) && ['youtube', 'instagram', 'tiktok'].includes(p),
    );
    if (newlyDiscarded.length > 0 && (fileName || contentId)) {
      const remoteQuery = contentId ? { userId, contentId } : { userId, fileName };
      RemoteLibraryVideoModel.updateOne(
        { ...remoteQuery, platforms: { $nin: newlyDiscarded } } as any,
        { $addToSet: { platformsDiscarded: { $each: newlyDiscarded } } },
      ).catch((err: any) => logger.warn('remote_library_discard_propagation_failed', { errorName: errorName(err) }));
    }
  } catch (err: any) {
    res.status(500).json({ message: err.message });
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
  deviceId?: string | null;
  source?: string | null;
  fileName?: string | null;
  contentId?: string | null;
  // Bug preexistente encontrado de paso (no de esta tarea): faltaba en el
  // tipo aunque varios callers ya lo mandaban y el cuerpo de la función ya
  // lo usaba -- tsc lo marcaba como "no existe en el tipo" en 3 lugares.
  remoteLibraryVideoId?: string | null;
  title?: string | null;
  publishedAt?: Date;
  matchStatus?: string;
}): Promise<{ linkedFileId: any | null; publishedAt: Date }> {
  if (!data.platformId) return { linkedFileId: null, publishedAt: data.publishedAt ?? new Date() };
  // any: llega de request bodies (recordUploadEvent, confirmLink, uploaders)
  // que ya validan el valor contra su propia lista de plataformas antes de
  // llegar acá -- este helper es compartido por varios callers con sus
  // propios union types (Platform, SyncPlatform, RemotePlatform), ninguno
  // 100% igual entre sí.
  const platform = data.platform as any;
  let platformId = data.platformId;
  const { platformUrl, fileName, contentId, title } = data;
  const matchStatus = data.matchStatus ?? 'manual';

  // Un link de Instagram pegado a mano solo trae el shortcode del permalink
  // (ver extractPlatformId en local-backend/video.controller.ts) -- Graph API
  // necesita el media id numérico real, si no las stats de Estadísticas
  // quedan en 0 para siempre (bug real detectado con "beta - blackbery.mp4").
  // Best-effort: si no lo puede resolver, sigue con el shortcode tal cual.
  if (platform === 'instagram' && !/^\d+$/.test(platformId)) {
    try {
      const { resolveInstagramMediaId } = await import('../services/instagram.service');
      const resolved = await resolveInstagramMediaId(userId, platformUrl ?? platformId);
      if (resolved) platformId = resolved;
    } catch { /* sigue con el shortcode -- no bloquea el link/badge */ }
  }

  // Mismo criterio que Instagram arriba: un publish_id crudo de TikTok (el id
  // de la OPERACIÓN de publicar, no del video -- ver tiktok-upload.controller.ts)
  // guardado como platformId rompía en silencio el link y las stats para
  // siempre. Cada uploader ya lo resuelve en su propio flujo, pero esto es la
  // red de seguridad centralizada para cualquier OTRO caller. Best-effort: si
  // no lo puede resolver (privacidad SELF_ONLY, token vencido, etc.), sigue
  // con el valor tal cual.
  if (platform === 'tiktok' && !/^\d+$/.test(platformId)) {
    try {
      const { resolveTikTokVideoId } = await import('../services/tiktok.service');
      const resolved = await resolveTikTokVideoId(userId, platformId);
      if (resolved) platformId = resolved;
    } catch { /* sigue con el valor original -- no bloquea el link/badge */ }
  }

  // Sin publishedAt del caller (típico: un link pegado a mano para un video
  // que ya estaba publicado de antes, ver setPlatformLink en local-backend) --
  // antes se caía directo a `new Date()` y el video quedaba marcado como
  // "publicado ahora" aunque fuera viejo. Bug real detectado 2026-08-15 con
  // un link de Instagram de abril mostrado como recién publicado (afecta el
  // orden de Estadísticas por plataforma, que ordena por publishedAt). Va
  // DESPUÉS de resolver platformId arriba -- con el id ya numérico/real, no
  // con el shortcode/publish_id crudo. Best-effort: si la plataforma no
  // responde (token vencido, red, video privado), se cae a `new Date()` como
  // antes -- nunca bloquea el link/badge por esto.
  let publishedAtDate = data.publishedAt;
  if (!publishedAtDate) {
    try {
      if (platform === 'youtube') publishedAtDate = (await getYoutubePublishedAt(platformId)) ?? undefined;
      else if (platform === 'instagram') publishedAtDate = (await getInstagramPublishedAt(userId, platformId)) ?? undefined;
      else if (platform === 'tiktok') publishedAtDate = (await getTiktokPublishedAt(userId, platformId)) ?? undefined;
    } catch { /* best-effort -- sigue al fallback de abajo */ }
  }
  publishedAtDate = publishedAtDate ?? new Date();

  let linkedFileId: any = null;
  let publishedFile: { _id: any; file_name: string; fecha_creacion?: Date | null } | null = null;
  if (fileName) {
    const file = await resolveOrCreateFile(userId, { fileName, contentId, remoteLibraryVideoId: data.remoteLibraryVideoId });
    if (file) {
      linkedFileId = file._id;
      // BUG-2026-08-15-03: acá SIEMPRE hay un platformId real (se corta arriba
      // si no lo hay), así que esto es 'confirmed' -- incluso si `platform` ya
      // estaba en `file.platforms` como marca manual ('badge_only', ver
      // updateFilePlatforms), este publish real la promueve. Antes esa
      // promoción no pasaba nunca porque el `if` de abajo solo miraba el
      // array plano, no el estado real detrás.
      const currentState = (file.platform_states ?? []).find((s) => s.platform === platform)?.state;
      if (!file.platforms.includes(platform) || currentState !== 'confirmed') {
        const newStates = upsertConfirmed(file.platform_states ?? [], platform as any);
        await FileModel.updateOne(
          { _id: file._id },
          { $addToSet: { platforms: platform }, $pull: { platforms_discarded: platform }, $set: { platform_states: newStates } },
        );
      }
      publishedFile = { _id: file._id, file_name: file.file_name, fecha_creacion: file.fecha_creacion };
    }
  }

  // Si el shortcode no se pudo resolver arriba y ya existe un registro con el
  // media id numérico real para este mismo video, crear otro con el shortcode
  // sin resolver solo produce un duplicado con views/likes/comments en 0 para
  // siempre (Graph API no acepta el shortcode para pedir stats) que además
  // termina pisando al bueno en Estadísticas (getGroupStats no tenía
  // criterio de desempate). En ese caso se actualiza el link/título del
  // registro bueno en vez de crear uno nuevo.
  const numericSibling = (platform === 'instagram' && !/^\d+$/.test(platformId) && linkedFileId)
    ? await PlatformVideoModel.findOne({ userId, platform, linkedFileId, platformId: { $regex: /^\d+$/ } })
        .select('_id')
        .lean()
    : null;

  if (numericSibling) {
    await PlatformVideoModel.updateOne(
      { _id: numericSibling._id },
      { $set: { platformUrl: platformUrl ?? '', title: title ?? '' } },
    );
  } else {
    // Si este file+platform ya tenía OTRO platformId linkeado (ej. un link mal
    // pegado que después se corrige, o un re-match), ese doc viejo queda
    // desvinculado antes de crear/actualizar el nuevo -- si no, los dos quedan
    // compitiendo por el mismo slot en buildFilePlatforms (desempate por
    // lastSyncedAt), y cuál "gana" en Estadísticas/Dashboard queda a merced de
    // qué doc se sincronizó último, mostrando a veces el bueno y a veces un
    // duplicado roto con 0 vistas. Mismo criterio que ya usa
    // resolveCrossMatchSlot para el cross-match manual -- acá faltaba para el
    // resto de los callers (recordUploadEvent, uploaders directos).
    if (linkedFileId) {
      await PlatformVideoModel.updateMany(
        { userId, platform, linkedFileId, platformId: { $ne: platformId } },
        { $set: { linkedFileId: null, matchStatus: 'sin_match' } },
      );
    }
    // publishedAt va en $setOnInsert, no en $set: una vez fijado para este
    // platform+platformId no debe volver a pisarse por una llamada repetida
    // (reintento de recordUploadEvent, outbox de local-backend reenviando un
    // evento viejo, etc.) -- si no, una corrección manual hecha en Mongo (o
    // una fecha real ya resuelta por getXPublishedAt) queda expuesta a que la
    // siguiente llamada la vuelva a pisar con `new Date()`. Bug real: BUG-2026-08-15-06,
    // "clip - enemigos tiene.mp4" corregido a mano y vuelto a aparecer como
    // "recién publicado" horas después por un reintento con el mismo platformId.
    await PlatformVideoModel.updateOne(
      { userId, platform, platformId },
      {
        $set: {
          userId, platform, platformId,
          platformUrl:  platformUrl ?? '',
          title:        title ?? '',
          linkedFileId,
          matchStatus,
          lastSyncedAt: new Date(),
        },
        $setOnInsert: { publishedAt: publishedAtDate },
      },
      { upsert: true },
    );
  }

  await mirrorPlatformVideoToBackup(userId, {
    platform, platformId, platformUrl, fileName, contentId, title,
    remoteLibraryVideoId: data.remoteLibraryVideoId,
    deviceId: data.deviceId, source: data.source,
    publishedAt: publishedAtDate, matchStatus,
  });

  await syncCalendarAfterPublish(userId, platform, publishedFile, publishedAtDate);

  // E: si el mismo video (por fileName o contentId) también vive en Biblioteca
  // remota, refleja la plataforma ahí también -- solo altas, nunca desvincula
  // ni descarta desde acá (mismo criterio conservador que bulkUpsertBackupFiles
  // usa para no pisar decisiones tomadas directamente en Nube). RemoteLibraryVideoModel
  // no tiene 'facebook' en su enum de plataformas (solo youtube/instagram/tiktok).
  if ((fileName || contentId) && ['youtube', 'instagram', 'tiktok'].includes(platform)) {
    try {
      const remoteQuery = contentId ? { userId, contentId } : { userId, fileName };
      const remote = await RemoteLibraryVideoModel.findOne(remoteQuery as any);
      // Mismo criterio de promoción que arriba para FileModel: un badge_only
      // puesto antes en Nube (marca manual) se promueve a 'confirmed' apenas
      // hay un platformId real, no solo cuando la plataforma era nueva.
      const remoteState = (remote?.platformStates ?? []).find((s) => s.platform === platform)?.state;
      if (remote && (!remote.platforms.includes(platform as any) || remoteState !== 'confirmed')) {
        const keptLinks = (remote.platformLinks ?? []).filter((l) => l.platform !== platform);
        const newRemoteStates = upsertConfirmed(remote.platformStates ?? [], platform as any);
        await RemoteLibraryVideoModel.updateOne(
          { _id: remote._id },
          {
            $addToSet: { platforms: platform },
            $pull: { platformsDiscarded: platform },
            $set: {
              platformLinks: [...keptLinks, { platform, platformId, platformUrl: platformUrl ?? '', publishedAt: publishedAtDate }],
              platformStates: newRemoteStates,
            },
          },
        );
      }
    } catch (err: any) {
      logger.warn('remote_library_publish_sync_failed', { errorName: errorName(err) });
    }
  }

  return { linkedFileId, publishedAt: publishedAtDate };
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
    const { deviceId, deviceName, source, platform, platformId, platformUrl, fileName, contentId, remoteLibraryVideoId, title, publishedAt, operationId } = req.body ?? {};
    if (!platform || !platformId) {
      res.status(400).json({ message: 'platform y platformId son requeridos.' });
      return;
    }
    // OJO: NO defaultear acá a `new Date()`. Antes esta línea calculaba su
    // propio fallback y se lo pasaba a applyPlatformPublish ya resuelto
    // (truthy), lo que hacía que el fetch best-effort de la fecha real
    // (getYoutube/Instagram/TiktokPublishedAt, ver `if (!publishedAtDate)`
    // más abajo en applyPlatformPublish) NUNCA se ejecutara para este
    // caller -- BUG-2026-08-15-06: un link viejo de Instagram quedaba con
    // publishedAt="ahora" en cada reintento/republish del mismo evento,
    // incluso después de corregirlo a mano en Mongo. Ahora se deja
    // `undefined` cuando el caller no lo manda, y se usa la fecha que
    // applyPlatformPublish efectivamente resolvió (real o `new Date()` como
    // último fallback) para el registro de Historial también.
    const publishedAtInput = publishedAt ? new Date(publishedAt) : undefined;

    const { publishedAt: publishedAtDate } = await applyPlatformPublish(userId, {
      platform, platformId, platformUrl, fileName, contentId, remoteLibraryVideoId, title,
      deviceId, source,
      publishedAt: publishedAtInput, matchStatus: 'manual',
    });

    // publishedAt en $setOnInsert (no $set): mismo criterio que
    // PlatformVideoModel en applyPlatformPublish -- una vez fijado para este
    // platform+platformId, un reintento posterior (retry del cliente, outbox
    // de local-backend reenviando el mismo evento) no debe volver a pisarlo.
    await UploadHistoryModel.updateOne(
      { userId, platform, platformId },
      {
        $set: {
          userId, platform, platformId,
          deviceId:    deviceId    ?? 'desconocido',
          source:      source      ?? 'desconocido',
          platformUrl: platformUrl ?? null,
          fileName:    fileName    ?? null,
          contentId:   contentId   ?? null,
          title:       title       ?? null,
          // Best-effort: iOS/Android todavía no lo mandan en todos los
          // callers -- si no viene, no se pisa un operationId previo con null
          // (ej. un reintento sin ese campo actualizando el mismo platformId).
          ...(operationId ? { operationId } : {}),
        },
        $setOnInsert: { publishedAt: publishedAtDate },
      },
      { upsert: true },
    );

    // Fase 5 (auditoría): a diferencia de UploadHistoryModel (que UPDATEA el
    // registro por platform+platformId -- una republicación pisa el
    // anterior), esto es un evento más en el log append-only, uno por cada
    // llamada real a este endpoint, republicaciones incluidas.
    await recordAuditEvent({
      userId, type: 'publish_confirmed', platform,
      installationId: deviceId, deviceName, source, operationId,
      entity: { kind: 'platform_video', id: platformId, label: title || fileName || undefined },
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
      source:       h.source ?? null,
      operationId:  h.operationId ?? null,
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
