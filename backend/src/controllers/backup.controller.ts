import { Response } from 'express';
import { AuthRequest, isOwner } from '../middleware/auth.middleware';
import { BackupFileModel } from '../models/backup-file.model';
import { TranscriptBackupModel } from '../models/transcript-backup.model';
import { randomUUID } from 'crypto';
import { FileModel } from '../models/file.model';
import { UserModel } from '../models/user.model';
import { IdeaCentral } from '../models/ideaCentral';
import { BackupConfigModel } from '../models/backup-config.model';
import { BackupPlatformVideoModel, noEsMasNuevaEnEsteArchivo } from '../models/backup-platform-video.model';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { UploadHistoryModel } from '../models/upload-history.model';
import { PlatformVideoModel } from '../models/platform-video.model';
import { recordAuditEvent } from '../services/audit.service';
import { getVideoPublishedAt as getYoutubePublishedAt } from '../services/youtube.service';
import { getMediaPublishedAt as getInstagramPublishedAt } from '../services/instagram.service';
import { getVideoPublishedAt as getTiktokPublishedAt } from '../services/tiktok.service';
import { upsertConfirmed, deriveStatesFromToggle } from '../utils/platform-state.util';
import {
  getCanonicalBackupFiles,
  getCanonicalBackupStatus,
  getCanonicalSyncStatusBackedUpSet,
} from '../services/backup-file-canonical.service';
import { maybeCompareCanary } from '../services/backup-canary-comparator.service';
import {
  mergeRemoteResolutionDelta,
  RemoteSyncPlatform,
} from '../services/remote-library-platform-sync.service';

// Entrega A de docs/mongo-collections-consolidation-plan-2026-09-02.md:
// interruptor para leer los 3 endpoints GET de /api/backup desde `files`
// exclusivamente (backup-file-canonical.service.ts) en vez del merge viejo
// contra `backup_files`. Default apagado a propósito -- activarlo primero
// solo para la comparación/allowlist canary de la Entrega C, nunca en
// producción real hasta que esa comparación cierre sin diferencias. El
// bulk de escritura (bulkUpsertBackupFiles) NO está gateado por esto: sigue
// escribiendo ambas colecciones igual que hoy, eso se retira recién en la
// Entrega D.
const BACKUP_CANONICAL_READS = process.env.BACKUP_CANONICAL_READS === 'true';

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

    if (BACKUP_CANONICAL_READS) {
      const { files, video_folder } = await getCanonicalBackupFiles(userId, includeResolved);
      res.json({ files, total: files.length, video_folder });
      return;
    }

    const [allFiles, user, centralFiles] = await Promise.all([
      BackupFileModel.find({ userId }).lean(),
      UserModel.findById(userId, { video_folder: 1 }).lean(),
      // BackupFileModel solo tiene lo que ALGUNA instalación local llegó a pushear.
      // Lo que se resolvió por el flujo de Sincronizar/cross-match (central, dueño)
      // nunca pasa por ahí — vive solo en FileModel ('files'). Sin este merge, un
      // wipe de logout + pull no recupera esos videos (bug real, ver incidente de
      // julio 2026 / fix-local-files-platforms.js): el pull queda tan incompleto
      // como el propio push, aunque en la nube exista el dato correcto en otro lado.
      // `platform_rev` y `content_id` viajan JUNTO con el estado a propósito:
      // la revisión describe ESTE estado, y sirve como `baseVersion` de la
      // próxima transición. Mientras el cliente las pedía por separado, una
      // publicación entre las dos respuestas lo dejaba con el estado de antes y
      // la revisión de después -- y una desvinculación decidida sobre lo viejo
      // salía declarando la revisión nueva, así que la central la ACEPTABA.
      // Un cliente atrasado tiene que fallar con 409, no acertarle de casualidad.
      FileModel.find({ userId }).select('file_name content_id platforms platforms_discarded platform_states platform_rev content_status scheduled_date duracion_segundos resolucion formato fecha_creacion updatedAt').lean(),
    ]);

    const centralByName = new Map(centralFiles.map(f => [f.file_name, f]));
    // Índice APARTE, por content_id, y solo para la revisión.
    //
    // El merge por `file_name` es histórico y sigue sirviendo para los badges,
    // pero dos documentos distintos pueden compartir nombre con `content_id`
    // distintos (reimportaciones, un archivo renombrado a un nombre ya usado) y
    // `centralByName` se queda con el último que ve. Mientras eso solo movía
    // badges era un problema conocido de este endpoint; con la revisión adentro
    // es otra cosa, porque la revisión ES la identidad del estado: entregar la
    // de un content_id bajo el nombre de otro deja al cliente declarando la
    // `baseVersion` de un archivo que no es el suyo.
    //
    // El nombre sigue siendo FALLBACK, pero solo para el estado y sin revisión.
    // Tomar el estado por nombre y la revisión por content_id era peor que
    // cualquiera de las dos cosas sola: entregaba una pareja estado+revisión
    // que nunca existió en ningún documento, y encima la revisión era la
    // correcta para la identidad del cliente, así que su próxima transición
    // pasaba el CAS sin problema -- aplicada sobre el estado de otro archivo.
    const centralById = new Map(
      centralFiles.filter(f => f.content_id).map(f => [String(f.content_id), f]),
    );
    const backupNames = new Set(allFiles.map(f => f.file_name));
    const enriched = allFiles.map(f => {
      const current = (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0);
      // Primero por content_id, que es la identidad. El nombre solo cuando no
      // hay match por identidad -- y en ese caso lo que se sirva NO lleva
      // revisión, porque describe a un documento que no es este.
      const porId = (typeof f.content_id === 'string') ? centralById.get(f.content_id) : undefined;
      const central = porId ?? centralByName.get(f.file_name);
      const mismoDocumento = !!porId;
      const revisionDelDocumento = mismoDocumento ? (porId as any).platform_rev : undefined;
      // BUG-2026-08-15-03: platform_states vive solo en FileModel (central) --
      // BackupFileModel (de donde sale `f`) nunca tuvo el concepto de
      // confirmed/badge_only, así que siempre hay que traerlo de acá cuando
      // exista un match central, sin importar si platforms/platforms_discarded
      // ya coincidían (esa comparación de abajo es para decidir si hace falta
      // pisar los arrays planos, no para esto).
      const platform_states = central?.platform_states ?? (f as any).platform_states;
      // REGLA: solo se adjunta `platform_rev` cuando el estado que se está
      // sirviendo sale del MISMO documento del que sale la revisión. Si el
      // estado viene de `backup_files` y la revisión de `files`, la pareja es
      // incoherente -- y de las dos formas de equivocarse, informar una
      // revisión MÁS NUEVA que el estado servido es la peligrosa: hace que la
      // central acepte una decisión que el cliente tomó sobre otra cosa.
      // Omitirla solo degrada a un 409, que es recuperable.
      if (current >= 3) return { ...f, platform_states };
      if (!central) return { ...f, platform_states };
      const centralPlatforms = [...(central.platforms ?? [])].sort().join('|');
      const currentPlatforms = [...(f.platforms ?? [])].sort().join('|');
      const centralDiscarded = [...(central.platforms_discarded ?? [])].sort().join('|');
      const currentDiscarded = [...(f.platforms_discarded ?? [])].sort().join('|');
      if (centralPlatforms === currentPlatforms && centralDiscarded === currentDiscarded) {
        // Coinciden, así que lo que se sirve describe también al documento
        // central: su revisión es la que corresponde a este estado.
        return { ...f, platform_states, platform_rev: revisionDelDocumento };
      }
      // El pull del cliente compara local_updated_at antes de aplicar el
      // badge. Si devolvemos la marca vieja de BackupFileModel, Electron
      // puede recibir el enlace de PlatformVideo pero descartar el badge.
      return {
        ...f,
        platforms: central.platforms ?? f.platforms,
        platforms_discarded: central.platforms_discarded ?? f.platforms_discarded,
        platform_states,
        // El estado servido es el del documento central: su revisión también,
        // pero solo si ese documento es el de ESTE content_id (ver arriba).
        platform_rev: revisionDelDocumento,
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
        // Todo sale del mismo documento acá, estado y revisión incluidos.
        content_id:          (f as any).content_id ?? null,
        platform_rev:        (f as any).platform_rev,
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

    // Entrega C (docs/mongo-collections-consolidation-plan-2026-09-02.md §5):
    // comparación canary en paralelo, DESPUÉS de responder -- nunca puede
    // demorar ni romper esta request. Sin CANARY_USER_IDS configurado (o
    // fuera de esa allowlist) es un no-op inmediato, no pega a Mongo.
    maybeCompareCanary(userId, includeResolved, files).catch(() => undefined);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

const hasData = (arr: any): boolean => Array.isArray(arr) && arr.length > 0;

// Pausa administrativa de POST /api/backup/files/bulk -- Entrega B de
// docs/mongo-collections-consolidation-plan-2026-09-02.md ("Concurrencia y
// reentrada"): el apply global de mongo-files-consolidation.js necesita una
// ventana breve donde nadie escriba `files`/`backup_files` mientras se toma
// el snapshot y se corre la migración, sin depender solo de `ordered:false`
// para el resto de las garantías. En memoria del proceso a propósito -- es
// una pausa operativa de minutos activada a mano por quien corre la
// migración, no una config persistente; un restart del backend la limpia
// sola, que es el comportamiento correcto (nunca debe sobrevivir un deploy).
let bulkPauseUntil: number | null = null;

export function pauseBackupBulkWrites(seconds: number): { until: string } {
  bulkPauseUntil = Date.now() + Math.max(0, seconds) * 1000;
  return { until: new Date(bulkPauseUntil).toISOString() };
}

export function resumeBackupBulkWrites(): void {
  bulkPauseUntil = null;
}

// GET/POST de administración -- gateadas por requireOwner en las rutas.
export async function adminPauseBackupBulk(req: AuthRequest, res: Response): Promise<void> {
  const seconds = Number((req.body as any)?.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    res.status(400).json({ message: 'seconds debe ser un número entre 1 y 3600.' });
    return;
  }
  const result = pauseBackupBulkWrites(seconds);
  res.json({ ok: true, paused: true, ...result });
}

export async function adminResumeBackupBulk(_req: AuthRequest, res: Response): Promise<void> {
  resumeBackupBulkWrites();
  res.json({ ok: true, paused: false });
}

// POST /api/backup/files/bulk
// Upserts many records. Last-write-wins by local_updated_at — PERO un archivo que
// llega sin platforms/platforms_discarded (p.ej. un re-escaneo de disco tras un wipe,
// que no puede saber dónde se publicó cada video) NUNCA pisa un registro que en la
// nube sí tiene esa info, aunque su timestamp sea más nuevo. Así el backup real
// sobrevive a un catálogo reconstruido desde cero.
export async function bulkUpsertBackupFiles(req: AuthRequest, res: Response): Promise<void> {
  // Corta ANTES de tocar el body -- el plan exige "sin aceptar parcialmente
  // el body" durante la ventana de migración. Retry-After en segundos,
  // redondeado hacia arriba para no invitar a un reintento inmediato que
  // vuelva a pegar contra la ventana.
  if (bulkPauseUntil !== null) {
    if (Date.now() >= bulkPauseUntil) {
      bulkPauseUntil = null;
    } else {
      const retryAfterSeconds = Math.ceil((bulkPauseUntil - Date.now()) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(503).json({ message: 'Backup temporalmente en pausa por mantenimiento.', retryAfterSeconds });
      return;
    }
  }
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
        console.warn('[bulkUpsertBackupFiles] BackupFileModel.bulkWrite con errores parciales:', err.writeErrors?.length ?? err.message);
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
      { file_name: 1, content_id: 1, platforms: 1, platforms_discarded: 1, tipo_contenido: 1, platform_states: 1 },
    ).lean();
    const fileModelExistingByFileName  = new Map(fileModelExisting.map(e => [e.file_name, e]));
    const fileModelExistingByContentId = new Map(fileModelExisting.filter(e => e.content_id).map(e => [e.content_id as string, e]));
    const resolveFileModelExisting = (f: any) =>
      (f.content_id && fileModelExistingByContentId.get(f.content_id)) || fileModelExistingByFileName.get(f.file_name);

    try {
      await FileModel.bulkWrite(
        incoming.map(f => {
          const ex = resolveFileModelExisting(f);
          let { platforms, platforms_discarded, platforms_updated_at } = resolvePlatforms(f, ex as any);

          // BUG-2026-09-06-04 (ver docs/bug-reports.md): `resolvePlatforms`
          // (arriba) solo protege el caso "incoming viene vacío" -- si el push
          // de la PC trae `platforms` NO vacío (su copia local, que puede ser
          // vieja), gana siempre, sin comparar contra nada. FileModel es la
          // ÚNICA de las 2 colecciones que además tiene `platform_states` --
          // un publish real (`applyPlatformPublish`, o el link pegado desde
          // Nube, ver BUG-2026-09-06-02) puede haber confirmado una plataforma
          // acá que la PC todavía no sabe que existe (nunca hizo pull todavía,
          // o su próximo push salió ANTES del pull). Sin esto, ese push de la
          // PC revierte silenciosamente un link real recién confirmado -- caso
          // real confirmado en producción: `final - linux gaming.mp4` volvió a
          // quedar sin Instagram en `platforms` ~30s después de repararlo,
          // pese a que `platform_states.instagram` seguía en `confirmed`.
          // Nunca se quita una plataforma `confirmed` de `platforms` ni se la
          // deja entrar a `platforms_discarded` por un push que no la conoce.
          const confirmedElsewhere: string[] = ((ex as any)?.platform_states ?? [])
            .filter((s: any) => s.state === 'confirmed')
            .map((s: any) => s.platform);
          if (confirmedElsewhere.length > 0) {
            platforms = Array.from(new Set([...platforms, ...confirmedElsewhere]));
            platforms_discarded = platforms_discarded.filter((p: string) => !confirmedElsewhere.includes(p));
          }

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
                  // Entrega A de la consolidación (docs/mongo-collections-consolidation-plan-2026-09-02.md
                  // §5) -- `files` empieza a absorber lo mismo que hoy solo vive en
                  // `backup_files`, sin todavía cambiar qué colección leen los 4 endpoints
                  // de /api/backup (eso lo hace el flag BACKUP_CANONICAL_READS). No pisa
                  // tipo_contenido con null si este push no lo trae (regla 7 del plan:
                  // "se copia si falta en files").
                  tipo_contenido:           f.tipo_contenido ?? (ex as any)?.tipo_contenido ?? null,
                  local_updated_at:         new Date(f.local_updated_at),
                  platforms_updated_at,
                  backup_synced_at:         new Date(),
                  backup_source_device_id:  deviceId ?? null,
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
      console.warn('[bulkUpsertBackupFiles] FileModel.bulkWrite con errores parciales:', err.writeErrors?.length ?? err.message);
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
    // ya quedó resuelto en FileModel. Los descartes también son una resolución:
    // antes este bloque calculaba únicamente `newlyPublished`, por lo que un
    // descarte hecho sobre la fila LAN llegaba a SQLite/FileModel pero la fila
    // Nube del mismo video seguía apareciendo pendiente en iOS.
    //
    // Se compara contra Nube en cada full push y solo se escriben divergencias.
    // Esto también repara casos que quedaron desalineados antes de desplegar el
    // fix; calcular solo el delta contra el FileModel previo no podría verlos.
    const canUseCloudStorage = isOwner(req.user!.username)
      || (req.user!.tier === 'premium' && req.user!.hasCloudStorage === true);
    if (canUseCloudStorage) {
      const resolvedForRemote = incoming
        .map(f => {
          const ex = resolveFileModelExisting(f);
          const { platforms, platforms_discarded } = resolvePlatforms(f, ex as any);
          const isRemotePlatform = (p: string): p is RemoteSyncPlatform =>
            ['youtube', 'instagram', 'tiktok'].includes(p);
          const desiredPublished = (platforms as string[]).filter(isRemotePlatform);
          const desiredDiscarded = (platforms_discarded as string[]).filter(isRemotePlatform);
          return desiredPublished.length > 0 || desiredDiscarded.length > 0
            ? { contentId: f.content_id, fileName: f.file_name, desiredPublished, desiredDiscarded }
            : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      if (resolvedForRemote.length > 0) {
        const remoteContentIds = resolvedForRemote.map(n => n.contentId).filter(Boolean);
        const remoteVideos = await RemoteLibraryVideoModel.find(
          {
            userId,
            $or: [
              { fileName: { $in: resolvedForRemote.map(n => n.fileName) } },
              ...(remoteContentIds.length ? [{ contentId: { $in: remoteContentIds } }] : []),
            ],
          },
          { contentId: 1, fileName: 1, platforms: 1, platformsDiscarded: 1, platformStates: 1 },
        ).lean();
        const remoteByName = new Map(remoteVideos.map(v => [v.fileName, v]));
        const remoteByContentId = new Map(remoteVideos.filter(v => v.contentId).map(v => [v.contentId as string, v]));

        const remoteOps = resolvedForRemote
          .map(n => {
            const remote = (n.contentId && remoteByContentId.get(n.contentId)) ?? remoteByName.get(n.fileName);
            if (!remote) return null; // este video nunca estuvo en Nube, nada que sincronizar
            const remotePublished = new Set(remote.platforms ?? []);
            const remoteDiscarded = new Set(remote.platformsDiscarded ?? []);
            const missingPublished = n.desiredPublished.filter(p => !remotePublished.has(p));
            const missingDiscarded = n.desiredDiscarded.filter(p => !remoteDiscarded.has(p));
            if (missingPublished.length === 0 && missingDiscarded.length === 0) return null;
            const merged = mergeRemoteResolutionDelta(remote, missingPublished, missingDiscarded);
            return {
              updateOne: {
                filter: { _id: remote._id },
                update: { $set: merged },
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

    const validos = incoming.filter(v => v && v.platform && v.platform_id);

    // Guard de tombstone. Este endpoint recibe el push periódico de CADA
    // escritorio, con su copia local -- que puede estar atrasada. Si una PC
    // soltó la plataforma y otra todavía tiene el vínculo viejo, el push de la
    // segunda llegaba y RESUCITABA el link, pisando el tombstone antes de que
    // esa misma PC alcanzara a leerlo en su pull. El ciclo se cerraba solo y el
    // unlink no se propagaba nunca.
    //
    // Regla: un push cuyo `local_updated_at` es ANTERIOR al `link_updated_at`
    // del tombstone no puede tocar el vínculo. Se compara contra el reloj
    // propio del link, no contra `local_updated_at` guardado (que se mueve con
    // cualquier campo de la fila y no sirve para decidir esto).
    //
    // Se leen los existentes primero en vez de meter la condición en el filtro
    // del bulkWrite: con `upsert: true`, un filtro que no matchea INSERTA, y
    // acá eso violaría el índice único {userId, platform, platform_id}.
    const claves = validos.map(v => ({ platform: v.platform, platform_id: v.platform_id }));
    const existentes = claves.length
      ? await BackupPlatformVideoModel.find(
          { userId, $or: claves },
          { platform: 1, platform_id: 1, link_state: 1, link_updated_at: 1, content_id: 1, link_version: 1 },
        ).lean()
      : [];
    const tombstonePorClave = new Map(
      existentes
        .filter((e: any) => e.link_state === 'unlinked')
        .map((e: any) => [`${e.platform}:${e.platform_id}`, e.link_updated_at ? new Date(e.link_updated_at).getTime() : 0]),
    );

    // Crear o revivir un vínculo es un cambio de estado: sube su revisión. Sin
    // eso, un teléfono que ya aplicó la lápida la compara, la ve igual, y no lo
    // revive nunca. Refrescar una fila que ya estaba viva no cambia nada.
    const existentePorClave = new Map(existentes.map((e: any) => [`${e.platform}:${e.platform_id}`, e]));
    // Completar el contenido de una fila vieja que no lo tenía también: dos PCs
    // que la completan a la vez leen el mismo número, y si no sube, las dos
    // pasan el CAS y la segunda pisa a la primera.
    const cambiaElVinculo = (v: any) => {
      const clave = `${v.platform}:${v.platform_id}`;
      const e: any = existentePorClave.get(clave);
      return !e || tombstonePorClave.has(clave) || (!e.content_id && !!v.content_id);
    };
    // Una foto que intenta llevar un vínculo VIVO a otro contenido no es una
    // decisión: la PC solo no se enteró de que se reasignó. Reasignar es trabajo
    // de un publish o una transición, que traen revisión. Completar el contenido
    // de una fila vieja que no lo tenía no es mover nada.
    const mueveUnVinculoVivo = (v: any) => {
      const e: any = existentePorClave.get(`${v.platform}:${v.platform_id}`);
      return !!e && e.link_state !== 'unlinked' && !!e.content_id && e.content_id !== (v.content_id ?? null);
    };

    let ignoradosPorTombstone = 0;
    let ignoradosPorContenido = 0;
    const ops = validos
      .filter(v => {
        if (mueveUnVinculoVivo(v)) { ignoradosPorContenido++; return false; }
        const tomb = tombstonePorClave.get(`${v.platform}:${v.platform_id}`);
        if (tomb === undefined) return true;
        const empuje = v.local_updated_at ? new Date(v.local_updated_at).getTime() : 0;
        // Empate incluido: ante la duda gana el tombstone. Un link se puede
        // volver a crear con una acción explícita nueva; un unlink perdido en
        // un empate vuelve a dejar el dato zombi que veníamos persiguiendo.
        if (empuje <= tomb) { ignoradosPorTombstone++; return false; }
        return true;
      })
      .map(v => {
        const campos = {
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
          // Un push que SÍ gana vuelve a dejar el vínculo vivo.
          // `as const`: sin esto TS ensancha el literal a `string` y no
          // cierra contra el enum del schema.
          link_state:       'linked' as const,
        };
        // Leer y escribir son dos pasos, y lo que entre en el medio no puede
        // quedar pisado por esta foto. Una fila que no estaba es un INSERT: si
        // otro la creó mientras tanto, el E11000 dice que ganó. Una que estaba
        // se escribe con CAS contra el `link_version` que se leyó: si alguien la
        // cambió, no matchea.
        const e: any = existentePorClave.get(`${v.platform}:${v.platform_id}`);
        if (!e) {
          // Una PC no trae revisión de archivo: el sello queda en 0, así que
          // cualquier decisión posterior sobre ese archivo lo supera.
          return { insertOne: { document: { ...campos, link_file_rev: 0, link_version: 1 } } };
        }
        return {
          updateOne: {
            filter: {
              userId, platform: v.platform, platform_id: v.platform_id,
              link_version: typeof e.link_version === 'number' ? e.link_version : { $exists: false },
            },
            update: {
              $set: { ...campos, ...(cambiaElVinculo(v) ? { link_file_rev: 0 } : {}) },
              ...(cambiaElVinculo(v) ? { $inc: { link_version: 1 } } : {}),
            },
          },
        };
      });

    // `ordered: false`: una escritura que perdió no frena a las demás. Perder es
    // un CAS que no matchea (alguien cambió la fila) o un E11000 (alguien la
    // creó); cualquier otro error sigue siendo un error.
    //
    // `updated` = filas que el CAS ACEPTÓ (matcheadas + insertadas), no
    // documentos materialmente modificados: una foto idéntica a lo que ya había
    // cuenta aunque no cambie nada. Lo que dice es "esta foto no perdió contra
    // nadie", que es lo que la PC necesita saber; las que perdieron no cuentan.
    let aplicados = 0;
    if (ops.length > 0) {
      try {
        const r: any = await BackupPlatformVideoModel.bulkWrite(ops as any, { ordered: false });
        aplicados = (r?.matchedCount ?? 0) + (r?.insertedCount ?? 0);
      } catch (err: any) {
        const errores: any[] = Array.isArray(err?.writeErrors)
          ? err.writeErrors
          : err?.writeErrors ? [err.writeErrors] : err?.code === 11000 ? [err] : [];
        if (!errores.length || errores.some((w: any) => (w?.code ?? w?.err?.code) !== 11000)) throw err;
        const r: any = err?.result ?? {};
        aplicados = (r.matchedCount ?? r.nMatched ?? 0) + (r.insertedCount ?? r.nInserted ?? 0);
      }
    }

    res.json({ ok: true, updated: aplicados, ignoradosPorTombstone, ignoradosPorContenido });
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
// NOTA: el upsert de acá abajo va guardado por la revisión de ARCHIVO
// (`link_file_rev`) cuando el caller declara una, y solo contra el mismo
// contenido. Sin eso, un publish rezagado escribía `link_state: 'linked'`
// sobre el tombstone que una transición POSTERIOR acababa de dejar, y el
// vínculo resucitaba en todas las PCs en su próximo pull.
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
  /** Revisión de ESTADO del archivo que produjo este publish. Ver el guard de abajo. */
  revDelArchivo?: number;
}): Promise<void> {
  if (!data.platformId) return;
  // Un valor, no una expresión: dentro de un pipeline, un string que empieza con
  // `$` (una URL o un título cualquiera) se leería como un campo.
  const lit = (v: unknown) => ({ $literal: v });
  const contentId = data.contentId ?? null;
  // ¿Esta escritura CAMBIA el vínculo? Se decide contra la fila tal como está en
  // el momento de escribir, no contra una lectura previa: una fila nueva (sin
  // `link_state`), una lápida, u otro contenido. Repetir el mismo publish no
  // cambia nada: ni `link_version` ni el reloj del vínculo se mueven. (Una fila
  // de antes de `link_state` o de `content_id` cuenta como cambio una vez, la
  // primera que se escribe: un número de más, nunca uno de menos.)
  const cambia = {
    $or: [
      { $ne: ['$link_state', 'linked'] },
      { $ne: ['$content_id', contentId] },
    ],
  };
  try {
    await BackupPlatformVideoModel.updateOne(
    {
      userId, platform: data.platform, platform_id: data.platformId,
      // De OTRO contenido: es una reasignación del vínculo, y un publish es una
      // decisión nueva sobre él -- la revisión de A no dice nada sobre B. Del
      // MISMO contenido: decide la revisión de estado de ese archivo, como
      // siempre, para que un publish rezagado no reviva lo que una transición
      // posterior soltó.
      ...(typeof data.revDelArchivo === 'number' && data.contentId
        ? { $or: [
            { content_id: { $ne: data.contentId } },
            { content_id: data.contentId, ...noEsMasNuevaEnEsteArchivo(data.revDelArchivo) },
          ] }
        : {}),
    },
    // Pipeline de UNA etapa: todas las expresiones leen la fila como estaba antes
    // de esta escritura, así que `cambia` no ve los valores que se ponen acá.
    [{
      $set: {
        userId: lit(userId), platform: lit(data.platform), platform_id: lit(data.platformId),
        platform_url:     lit(data.platformUrl ?? null),
        device_id:        lit(data.deviceId ?? null),
        source:           lit(data.source ?? null),
        published_at:     lit(data.publishedAt ?? new Date()),
        file_name:        lit(data.fileName  ?? null),
        content_id:       lit(contentId),
        match_status:     lit(data.matchStatus ?? 'manual'),
        title:            lit(data.title ?? null),
        local_updated_at: '$$NOW',
        // `timestamps: true` del modelo: con un pipeline Mongoose avanza
        // `updatedAt`, pero no pone `createdAt` al insertar. Se conserva el que
        // ya tenía; una fila nueva lo recibe ahora.
        createdAt:        { $ifNull: ['$createdAt', '$$NOW'] },
        // Resucita el vínculo explícitamente. Sin esto, desvincular y volver a
        // vincular EXACTAMENTE la misma publicación dejaba la fila con el
        // tombstone puesto (`unlinked`): el upsert la actualizaba pero nunca
        // limpiaba ese campo, y el siguiente pull la volvía a desvincular sola.
        link_state:       lit('linked'),
        // Reloj del vínculo: si no se mueve al revivirlo, el guard de tombstone
        // en bulkUpsertBackupPlatformVideos sigue comparando contra el instante
        // del unlink y descarta pushes legítimos posteriores. Si el vínculo no
        // cambió, tampoco se mueve: moverlo descartaría esos mismos pushes.
        link_updated_at:  { $cond: [cambia, '$$NOW', '$link_updated_at'] },
        // La revisión propia del vínculo sube en la misma operación que lo
        // cambia, y solo si lo cambia. Es lo que ordenan los dispositivos.
        link_version:     { $cond: [cambia, { $add: [{ $ifNull: ['$link_version', 0] }, 1] }, '$link_version'] },
        // Y la revisión de archivo, que es lo que compara el guard del tombstone
        // en applyPlatformTransition. Sin ella, ese guard mira un campo ausente
        // y una transición vieja tapa un re-vínculo nuevo. Avanza aunque el
        // vínculo sea el mismo: es la revisión causal que trae este publish.
        ...(typeof data.revDelArchivo === 'number' ? { link_file_rev: lit(data.revDelArchivo) } : {}),
      },
    }],
    { upsert: true, updatePipeline: true } as any,
    );
  } catch (err: any) {
    // Ídem: hay una fila más nueva para ese platformId.
    if (err?.code !== 11000) throw err;
  }
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
    console.warn('[calendar] sync tras publish falló:', err.message);
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
// Exportada (BUG-2026-09-06-01): remote-library.controller.ts la reusa por el
// mismo motivo -- un video subido/tocado desde Nube sin FileModel todavía
// quedaba invisible para Calendario/Cross-match/Videos, ver ese incidente.
export async function resolveOrCreateFile(
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
  // Con una identidad estable -- la que declaró el cliente o la del video de
  // Nube --, el nombre solo puede ADOPTAR un archivo que todavía no tiene
  // ninguna (un documento legado). Nunca uno con OTRA identidad: ese es otro
  // video que comparte el nombre, y vincularlo le daría la publicación a él.
  const adoptable = stableContentId ? { $or: [{ content_id: { $exists: false } }, { content_id: null }] } : {};
  if (!file) {
    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    file = await FileModel.findOne({ userId, file_name: { $regex: `^${escaped}$`, $options: 'i' }, ...adoptable });
  }
  // El nombre puede cambiar al clonar/importar el video en otro dispositivo;
  // el ID de Biblioteca remota/contentId es la identidad real.
  if (!file && remote?.fileName && remote.fileName !== fileName) {
    file = await FileModel.findOne({ userId, file_name: remote.fileName, ...adoptable });
  }
  // Si no hay ningún archivo local (ej. video publicado/descartado directo
  // desde el celular, sin pasar antes por el catálogo), se crea un registro
  // mínimo -- si no, Estadísticas/el pull del PC no tienen de dónde sacarlo y
  // queda invisible hasta que alguien lo vincule a mano en Videos (escritorio).
  if (!file && stableContentId) {
    // Con identidad estable se crea POR ella: upsert por `content_id`, no por
    // nombre -- por nombre, el upsert matchearía al homónimo. La ruta sale de
    // la identidad: con el nombre chocaría contra el índice único de ruta
    // cuando hay un homónimo.
    file = await FileModel.findOneAndUpdate(
      { userId, content_id: stableContentId },
      {
        $setOnInsert: {
          userId, file_name: fileName, file_path: `id/${stableContentId}/${fileName}`,
          status: 'PENDIENTE', content_id: stableContentId,
        },
      },
      { upsert: true, new: true },
    );
  } else if (!file) {
    file = await FileModel.findOneAndUpdate(
      { userId, file_name: fileName },
      { $setOnInsert: { userId, file_name: fileName, file_path: fileName, status: 'PENDIENTE' } },
      { upsert: true, new: true },
    );
  }

  // Un documento de antes de que existiera `content_id` no tiene ninguno, y
  // sin identidad no puede participar de ninguna transición causal: el
  // endpoint de transiciones la exige.
  //
  // Se le asigna una ATÓMICAMENTE. El filtro exige que SIGA sin identidad, así
  // que dos resoluciones concurrentes no pueden asignar dos distintas -- la
  // segunda no matchea y relee la que quedó. Leer-decidir-escribir acá
  // produciría dos identidades para el mismo documento.
  //
  // Va acá y no en `resolve-identity` porque este es el camino que resuelve
  // POR NOMBRE, que es la única forma de toparse con un documento legado. Ese
  // otro endpoint no busca por nombre a propósito.
  if (!file.content_id) {
    const conIdentidad = await FileModel.findOneAndUpdate(
      { _id: file._id, $or: [{ content_id: { $exists: false } }, { content_id: null }] },
      { $set: { content_id: stableContentId ?? randomUUID() } },
      { new: true },
    );
    file = conIdentidad ?? (await FileModel.findById(file._id)) ?? file;
  }

  return file;
}

/**
 * El video de Nube declarado y el archivo no pueden ser el mismo contenido. Es
 * ambiguo -- ningún documento se puede elegir sin adivinar --, así que la
 * publicación no escribe nada:
 * - `colision`: el declarado no tiene identidad, y otro video de la cuenta ya
 *   tiene la del archivo;
 * - `identidad_distinta`: el declarado ya tiene OTRA identidad (ej. el cliente
 *   declaró `contentId` Z y un id remoto cuyo video es X);
 * - `inexistente`: el id declarado no es un video de esta cuenta.
 */
export class ConflictoDeIdentidadDeNube extends Error {
  constructor(readonly detalle: {
    kind: 'colision' | 'identidad_distinta' | 'inexistente';
    remoteLibraryVideoId: string;
    contentId: string;
    remoteContentId: string | null;
    conflictingRemoteLibraryVideoId: string | null;
  }) {
    super(
      `el video de Nube ${detalle.remoteLibraryVideoId} no puede llevar la identidad ${detalle.contentId} ` +
      `(${detalle.kind})`,
    );
  }
}

/**
 * El video de Nube declarado lleva la MISMA identidad que el archivo: las
 * transiciones lo proyectan solo por `{ userId, contentId }`, así que uno sin
 * identidad nunca recibe un unlink ni un discard.
 *
 * Atómico y acotado a ESE documento de esta cuenta: si ya tiene otra
 * identidad, el filtro no matchea y no se pisa. Si otro video de la cuenta ya
 * lleva esta identidad, el índice único lo rechaza: conflicto -- nunca se
 * resuelve por nombre en silencio, ni se sigue como si nada.
 */
async function asignarIdentidadAlVideoDeNube(userId: string, remoteLibraryVideoId: string, contentId: string) {
  let asignado: any;
  try {
    asignado = await RemoteLibraryVideoModel.updateOne(
      { _id: remoteLibraryVideoId, userId, $or: [{ contentId: { $exists: false } }, { contentId: null }] },
      { $set: { contentId } },
    );
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const otro: any = await RemoteLibraryVideoModel.findOne({ userId, contentId }).select('_id').lean();
    throw new ConflictoDeIdentidadDeNube({
      kind: 'colision', remoteLibraryVideoId: String(remoteLibraryVideoId), contentId, remoteContentId: null,
      conflictingRemoteLibraryVideoId: otro ? String(otro._id) : null,
    });
  }
  if ((asignado?.matchedCount ?? 0) > 0) return;

  // No matcheó: el video ya tiene una identidad, o no es de esta cuenta. Solo
  // es válido si ya es LA MISMA. Con otra, o sin video, es un conflicto: seguir
  // escribiría la publicación en un archivo mientras Nube -- que el cliente
  // declaró -- nunca la recibe, y con un 200 el cliente borra la intención.
  const actual: any = await RemoteLibraryVideoModel.findOne({ _id: remoteLibraryVideoId, userId })
    .select('contentId').lean();
  if (actual && actual.contentId === contentId) return;
  throw new ConflictoDeIdentidadDeNube({
    kind: actual ? 'identidad_distinta' : 'inexistente',
    remoteLibraryVideoId: String(remoteLibraryVideoId), contentId,
    remoteContentId: actual?.contentId ?? null, conflictingRemoteLibraryVideoId: null,
  });
}

/**
 * La revisión con la que un publish que NO ganó revisión -- repetir un link ya
 * confirmado -- puede proyectar su vínculo, o `undefined` si no puede demostrar
 * que el estado canónico sigue siendo el suyo.
 *
 * Ese publish decidió con una foto de FileModel leída al principio. Si desde
 * entonces entró una transición, la revisión que se lea ahora es la de ELLA:
 * usarla como guard dejaría pasar las escrituras que ella acaba de superar. Se
 * da por suya solo si se demuestran las tres cosas juntas:
 *   - el archivo sigue con la plataforma `confirmed`;
 *   - este mismo platformId sigue vinculado a este archivo;
 *   - el sello del vínculo (`linkVersion` + `linkVersionFileId`) es esa
 *     revisión, de este archivo. Un vínculo sin sello solo es coherente con una
 *     plataforma cuya revisión nunca se movió (0): un vínculo de antes de los
 *     sellos, sobre el que todavía no hubo ninguna operación causal.
 *
 * `linkVersionFileId` es una INVARIANTE DEFENSIVA que la mutación no cubre:
 * `linkVersion` solo tiene sentido dentro del archivo que la produjo, y dos
 * archivos pueden coincidir en el número de revisión; sin comparar el archivo,
 * el sello de otro se aceptaría como propio. No se encontró un flujo que lo
 * distinga por sí solo (el único, un confirmLink cortado que devuelve el link
 * a este archivo, no pierde nada por bloquear), pero la regla se mantiene.
 *
 * El orden de las dos lecturas no aporta una garantía propia: si algo cambia
 * entre ellas, lo detecta la condición del vínculo o la del sello.
 */
async function revisionDemostradaDelVinculo(
  // any: el mismo `platform` de applyPlatformPublish, que ya llega validado por
  // cada caller contra su propio union type (ver el comentario de allá).
  userId: string, platform: any, platformId: string, linkedFileId: any,
): Promise<number | undefined> {
  const vinculo: any = await PlatformVideoModel.findOne({ userId, platform, platformId })
    .select('linkedFileId linkVersion linkVersionFileId').lean();
  const archivo: any = await FileModel.findById(linkedFileId)
    .select('platforms platform_states platform_rev').lean();
  if (!vinculo || !archivo) return undefined;
  const rev = ((archivo.platform_rev ?? {}) as Record<string, number>)[platform] ?? 0;
  const confirmado = (archivo.platforms ?? []).includes(platform)
    && (archivo.platform_states ?? []).some((s: any) => s.platform === platform && s.state === 'confirmed');
  const vinculadoAEste = String(vinculo.linkedFileId) === String(linkedFileId);
  const selloCoherente = typeof vinculo.linkVersion === 'number'
    ? vinculo.linkVersion === rev && String(vinculo.linkVersionFileId) === String(linkedFileId)
    : rev === 0;
  return confirmado && vinculadoAEste && selloCoherente ? rev : undefined;
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
      ).catch((err: any) => console.warn('[updateFilePlatforms] propagar descarte a Nube falló:', err.message));
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
  // El contenido del archivo que recibe el vínculo: es contra él que se decide
  // si una fila del espejo es del mismo archivo o una reasignación.
  let contentIdDelArchivo: string | null = contentId ?? null;
  let publishedFile: { _id: any; file_name: string; fecha_creacion?: Date | null } | null = null;
  /**
   * La revisión de esta plataforma que ESTE publish produjo.
   *
   * Se captura del propio `$inc`, no se relee. Releerla -- que es lo que se
   * hacía, en tres momentos distintos -- deja una ventana en la que una
   * transición posterior mueve la revisión y este publish la lee como si fuera
   * suya: termina sellando sus efectos, más viejos, con el número de ella. Lo
   * peor de los dos mundos, porque después ningún guard puede distinguirlos.
   *
   * `undefined` = este publish no cambió el estado de la plataforma (no hubo
   * `$inc`); en ese caso no sella nada, que es lo correcto: no tiene una
   * revisión propia que ofrecer.
   */
  let revGanada: number | undefined;
  if (fileName) {
    const file = await resolveOrCreateFile(userId, { fileName, contentId, remoteLibraryVideoId: data.remoteLibraryVideoId });
    if (file) {
      // ANTES de escribir nada: si el video de Nube declarado no puede llevar
      // la identidad del archivo, esto tira un conflicto y la publicación no
      // toca ningún documento.
      if (data.remoteLibraryVideoId && (file as any).content_id) {
        await asignarIdentidadAlVideoDeNube(userId, data.remoteLibraryVideoId, (file as any).content_id);
      }
      linkedFileId = file._id;
      contentIdDelArchivo = (file as any).content_id ?? contentIdDelArchivo;
      // BUG-2026-08-15-03: acá SIEMPRE hay un platformId real (se corta arriba
      // si no lo hay), así que esto es 'confirmed' -- incluso si `platform` ya
      // estaba en `file.platforms` como marca manual ('badge_only', ver
      // updateFilePlatforms), este publish real la promueve. Antes esa
      // promoción no pasaba nunca porque el `if` de abajo solo miraba el
      // array plano, no el estado real detrás.
      const currentState = (file.platform_states ?? []).find((s) => s.platform === platform)?.state;
      if (!file.platforms.includes(platform) || currentState !== 'confirmed') {
        // ESCRITURA ATÓMICA, en dos pasos. Antes esto calculaba el array
        // completo de `platform_states` con `upsertConfirmed` sobre una FOTO
        // previa y lo escribía con `$set`: read-modify-write del documento
        // entero. Si otra operación cambiaba el estado de OTRA plataforma en el
        // medio, este `$set` la borraba. Lost update confirmado forzando el
        // intercalado en el harness ("una transición y un publish concurrentes
        // no se pisan el estado") -- con `Promise.all` a secas el test pasaba
        // sin probar nada, porque la carrera no llegaba a darse.
        //
        // `$pull` + `$addToSet` en dos pasos porque no se puede hacer las dos
        // cosas sobre el mismo campo en una sola actualización. Cada paso toca
        // únicamente la entrada de ESTA plataforma.
        const tras = await FileModel.findOneAndUpdate(
          { _id: file._id },
          {
            $addToSet: { platforms: platform },
            $pull: { platforms_discarded: platform, platform_states: { platform } },
            $set: {
              // Sella el reloj de ESTADO cuando el estado cambia de verdad.
              // Sin esto, la precedencia de applyPlatformTransition no tiene
              // contra qué comparar: un unlink rezagado veía un
              // platforms_updated_at viejo, se creía más nuevo que la
              // republicación, y la borraba.
              //
              // Ojo con la diferencia: `new Date()` (AHORA, cuando cambió el
              // estado) y no `publishedAtDate` -- vincular hoy un video de hace
              // meses es un cambio de estado NUEVO aunque la publicación sea
              // vieja. Confundir las dos fechas es exactamente el error que el
              // caso 3 del harness integral vigila.
              platforms_updated_at: new Date(),
              [`platform_state_changed_at.${platform}`]: new Date(),
            },
            // Un publish también mueve la revisión causal de esa plataforma:
            // si no, una transición basada en la revisión ANTERIOR se aplicaría
            // encima de esta publicación creyéndose al día. `$inc` por path es
            // atómico y no toca las otras plataformas.
            $inc: { [`platform_rev.${platform}`]: 1 },
          },
          { new: true, projection: { platform_rev: 1 } },
        ).lean();
        // `new: true` para quedarse con LA revisión que produjo este $inc.
        revGanada = ((tras?.platform_rev ?? {}) as Record<string, number>)[platform];
        await FileModel.updateOne(
          { _id: file._id },
          { $addToSet: { platform_states: { platform, state: 'confirmed' } } },
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
      // Los que se sueltan acá también cambian de estado. Sin lápida en el
      // espejo, los dispositivos seguían recibiendo el anterior vivo junto al
      // nuevo: dos vínculos para el mismo archivo y plataforma, que un pull que
      // trate bien la ambigüedad termina sin mostrar.
      const reemplazados = await PlatformVideoModel
        .find({ userId, platform, linkedFileId, platformId: { $ne: platformId } })
        .select('platformId').lean();
      const desvinculados = await PlatformVideoModel.updateMany(
        { userId, platform, linkedFileId, platformId: { $ne: platformId } },
        { $set: { linkedFileId: null, matchStatus: 'sin_match' } },
      );
      // Cambiar CUÁL link respalda la plataforma es un cambio de estado, aunque
      // el badge no se mueva (ya estaba `confirmed`). Sin sellar el reloj acá,
      // una republicación con un link nuevo dejaba `platforms_updated_at` en su
      // valor viejo, y un unlink rezagado se creía más nuevo que ella y la
      // borraba -- justo el caso 3 del harness integral.
      //
      // Se condiciona a que algo haya cambiado de verdad (modifiedCount > 0):
      // un reintento del MISMO platformId no debe mover el reloj, porque eso
      // haría parecer rezagada a una operación posterior legítima.
      if ((desvinculados.modifiedCount ?? 0) > 0) {
        const trasRelink = await FileModel.findOneAndUpdate(
          { _id: linkedFileId },
          {
            $set: {
              platforms_updated_at: new Date(),
              [`platform_state_changed_at.${platform}`]: new Date(),
            },
            $inc: { [`platform_rev.${platform}`]: 1 },
          },
          { new: true, projection: { platform_rev: 1 } },
        ).lean();
        revGanada = ((trasRelink?.platform_rev ?? {}) as Record<string, number>)[platform];
      }
      if (contentIdDelArchivo) {
        for (const r of reemplazados) {
          if (!r.platformId) continue;
          try {
            await BackupPlatformVideoModel.updateOne(
              {
                userId, platform, platform_id: r.platformId, content_id: contentIdDelArchivo,
                ...(revGanada !== undefined ? noEsMasNuevaEnEsteArchivo(revGanada) : {}),
              },
              {
                $set: {
                  link_state: 'unlinked', link_updated_at: new Date(), content_id: contentIdDelArchivo,
                  ...(revGanada !== undefined ? { link_file_rev: revGanada } : {}),
                },
                $inc: { link_version: 1 },
                $setOnInsert: { local_updated_at: new Date(), match_status: 'sin_match' },
              },
              { upsert: true },
            );
          } catch (err: any) {
            // Hay una fila de otro archivo, o más nueva, para ese platformId.
            if (err?.code !== 11000) throw err;
          }
        }
      }
    }
  }

  // PRUEBA DEL ESTADO CANÓNICO, antes de TODAS las proyecciones del vínculo.
  //
  // Si este publish ganó una revisión, es la suya. Si no -- repetir un link que
  // ya estaba confirmado no la mueve, y un reintento idéntico no debe moverla --,
  // decidió con la foto de FileModel que leyó al principio, y una transición que
  // entró desde entonces quedaría pisada por escrituras sin guard. Antes esta
  // prueba se hacía solo para Nube: platformvideos y el espejo revivían lo que un
  // unlink posterior acababa de soltar. Sin revisión propia ni demostrada, no se
  // reescribe ninguna proyección del vínculo. (Sin archivo no hay estado causal
  // que proteger: esas escrituras siguen como siempre.)
  const revisionEfectiva = revGanada ?? (linkedFileId ? await revisionDemostradaDelVinculo(userId, platform, platformId, linkedFileId) : undefined);
  const proyectar = !linkedFileId || revisionEfectiva !== undefined;

  if (!numericSibling && proyectar) {
    // publishedAt va en $setOnInsert, no en $set: una vez fijado para este
    // platform+platformId no debe volver a pisarse por una llamada repetida
    // (reintento de recordUploadEvent, outbox de local-backend reenviando un
    // evento viejo, etc.) -- si no, una corrección manual hecha en Mongo (o
    // una fecha real ya resuelta por getXPublishedAt) queda expuesta a que la
    // siguiente llamada la vuelva a pisar con `new Date()`. Bug real: BUG-2026-08-15-06,
    // "clip - enemigos tiene.mp4" corregido a mano y vuelto a aparecer como
    // "recién publicado" horas después por un reintento con el mismo platformId.
    // El sello del propio documento decide si esta escritura todavía vale.
    //
    // Capturar la revisión del `$inc` evita sellar con un número ajeno, pero no
    // alcanza para no ESCRIBIR: una comprobación previa no ve a la operación
    // que entra mientras la escritura está en vuelo. Guardando el update contra
    // `linkVersion`, si una transición posterior ya dejó su número acá, este
    // publish no matchea -- y el upsert choca contra el índice único, que es la
    // prueba de que hay algo más nuevo que no hay que tocar (mismo criterio que
    // el upsert del tombstone en platform-transition.service.ts).
    try {
      await PlatformVideoModel.updateOne(
      {
        userId, platform, platformId,
        // El sello `linkVersion` es una revisión del archivo AL QUE PERTENECE:
        // solo se compara contra ese archivo. Contra otro, esto es una
        // reasignación, y el número de A no dice nada sobre B.
        ...(revisionEfectiva !== undefined
          ? { $or: [
              { linkVersion: { $exists: false } },
              { linkVersion: { $lte: revisionEfectiva } },
              { linkVersionFileId: { $exists: true, $ne: linkedFileId } },
              { linkVersionFileId: { $exists: false }, linkedFileId: { $ne: linkedFileId } },
            ] }
          : {}),
      },
      {
        $set: {
          userId, platform, platformId,
          platformUrl:  platformUrl ?? '',
          title:        title ?? '',
          linkedFileId,
          matchStatus,
          lastSyncedAt: new Date(),
          ...(revisionEfectiva !== undefined ? { linkVersion: revisionEfectiva, linkVersionFileId: linkedFileId } : {}),
        },
        $setOnInsert: { publishedAt: publishedAtDate },
      },
      { upsert: true },
      );
    } catch (err: any) {
      // 11000 = ya hay una fila para ese platformId con una revisión posterior.
      // Se la deja como está, a propósito.
      if (err?.code !== 11000) throw err;
    }
  }

  // Y la misma revisión en `backup_files`. Es la proyección que el publish
  // NUNCA tocó -- su badge lo mantiene el push del escritorio -- y por eso su
  // guard de revisión comparaba contra un campo que nadie escribía y dejaba
  // pasar cualquier transición vieja.
  //
  // Sellar acá no dice "este documento ya refleja la publicación": dice "nada
  // anterior a esta revisión se aplica más sobre esta plataforma", que es
  // verdad en TODAS las representaciones apenas la revisión se mueve.
  //
  // El documento es el de la identidad RESUELTA del archivo, no el del
  // `contentId` del request: el teléfono no lo manda, y su publicación quedaba
  // sin sellar acá hasta que alguien la reentregara con él.
  if (contentIdDelArchivo && revisionEfectiva !== undefined) {
    await BackupFileModel.updateOne(
      {
        userId, content_id: contentIdDelArchivo,
        $or: [
          { ['platform_rev.' + platform]: { $exists: false } },
          { ['platform_rev.' + platform]: { $lte: revisionEfectiva } },
        ],
      },
      { $set: { ['platform_rev.' + platform]: revisionEfectiva } },
    );
  }

  // Misma revisión para el espejo: sin sellarla, el guard del tombstone
  // (`link_version <= versionResultante`) compara contra un valor AUSENTE y
  // deja pasar la lápida sobre un re-vínculo posterior. Y la misma prueba: sin
  // revisión propia ni demostrada, el espejo no se reescribe.
  if (proyectar) {
    await mirrorPlatformVideoToBackup(userId, {
      platform, platformId, platformUrl, fileName, contentId: contentIdDelArchivo, title,
      remoteLibraryVideoId: data.remoteLibraryVideoId,
      deviceId: data.deviceId, source: data.source,
      publishedAt: publishedAtDate, matchStatus,
      revDelArchivo: revisionEfectiva,
    });
  }

  await syncCalendarAfterPublish(userId, platform, publishedFile, publishedAtDate);

  // E: si el mismo video también vive en Biblioteca remota, refleja la
  // plataforma ahí también -- solo altas, nunca desvincula ni descarta desde
  // acá (mismo criterio conservador que bulkUpsertBackupFiles usa para no pisar
  // decisiones tomadas directamente en Nube). RemoteLibraryVideoModel no tiene
  // 'facebook' en su enum de plataformas (solo youtube/instagram/tiktok).
  //
  // Se busca EL video de la MISMA identidad que el archivo: por el
  // `contentId` ya resuelto -- si el cliente declaró un id remoto, ese video ya
  // recibió esta identidad arriba, o la publicación terminó en conflicto -- y
  // por nombre solo como último recurso, y solo un video que todavía no tiene
  // identidad: el nombre no es identidad, y un video de Nube de OTRA identidad
  // no recibe esta publicación ni por su id ni por llamarse igual.
  if (['youtube', 'instagram', 'tiktok'].includes(platform)) {
    try {
      const remote =
        (contentIdDelArchivo
          ? await RemoteLibraryVideoModel.findOne({ userId, contentId: contentIdDelArchivo })
          : null)
        ?? (fileName
          ? await RemoteLibraryVideoModel.findOne({
            userId, fileName, $or: [{ contentId: { $exists: false } }, { contentId: null }],
          })
          : null);
      // Con la revisión de ESTE publish -- la que ganó, o la que demostró antes
      // de proyectar el vínculo (ver `revisionDemostradaDelVinculo`) --, Nube
      // refleja la publicación aunque ya estuviera `confirmed` con otro link: en
      // platformvideos ya soltó al anterior. Las dos escrituras van contra ella:
      // si una transición POSTERIOR sobre esta misma plataforma ya dejó su
      // revisión en Nube, no matchean, y el publish no resucita lo que ella soltó.
      if (remote && revisionEfectiva !== undefined) {
        const noEsMasNuevaQueEstePublish = {
          $or: [
            { ['platformRev.' + platform]: { $exists: false } },
            { ['platformRev.' + platform]: { $lte: revisionEfectiva } },
          ],
        };
        // ESCRITURA ATÓMICA en dos pasos, igual que arriba para FileModel.
        // Antes esto calculaba `platformStates` y `platformLinks` completos
        // desde una FOTO previa (`upsertConfirmed` + filter) y los escribía con
        // `$set`: read-modify-write del documento entero. Una transición que
        // tocara OTRA plataforma en el medio quedaba borrada.
        //
        // Es el mismo lost update que ya se había corregido en `FileModel`, en
        // esta misma función -- quedó vivo acá hasta que un test con el
        // intercalado FORZADO lo destapó ("transición y publish concurrentes
        // tampoco se pisan el estado en Nube"). Con `Promise.all` a secas el
        // caso pasaba sin probar nada.
        //
        // La primera escritura también SELLA la revisión de esta plataforma en
        // Nube. Es lo que permite que una transición vieja (que reclamó una
        // revisión anterior) no pueda pisar acá la publicación que acaba de
        // entrar -- su guard compara contra este sello -- y lo que la segunda
        // escritura exige: si entre las dos entró una transición posterior, el
        // sello ya es el suyo y la segunda no matchea.
        await RemoteLibraryVideoModel.updateOne(
          { _id: remote._id, ...noEsMasNuevaQueEstePublish },
          {
            $addToSet: { platforms: platform },
            $pull: {
              platformsDiscarded: platform,
              platformStates: { platform },
              platformLinks: { platform },
            },
            $set: { ['platformRev.' + platform]: revisionEfectiva },
          },
        );
        await RemoteLibraryVideoModel.updateOne(
          { _id: remote._id, ['platformRev.' + platform]: revisionEfectiva },
          {
            $addToSet: {
              platformStates: { platform, state: 'confirmed' },
              platformLinks: { platform, platformId, platformUrl: platformUrl ?? '', publishedAt: publishedAtDate },
            },
          },
        );
      }
    } catch (err: any) {
      console.warn('[applyPlatformPublish] sync a Biblioteca remota falló:', err.message);
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
  const userId = req.user!.id;
  const { deviceId, deviceName, source, platform, platformId, platformUrl, fileName, contentId, remoteLibraryVideoId, title, publishedAt, operationId } = req.body ?? {};
  try {
    if (!platform || !platformId) {
      res.status(400).json({ message: 'platform y platformId son requeridos.' });
      return;
    }
    // Un id remoto sin nombre de archivo es un payload INCOMPLETO, no una
    // contradicción entre identidades (eso es el 409 de abajo): sin nombre no se
    // resuelve ningún archivo, y la publicación quedaba asentada a medias -- un
    // vínculo sin archivo y un 200. Se rechaza sin escribir nada, y la evidencia
    // de que ocurrió queda en la auditoría. Aceptarla algún día exige resolverla
    // explícitamente desde el documento remoto, nunca como éxito silencioso.
    if (remoteLibraryVideoId && !fileName) {
      await recordAuditEvent({
        userId, type: 'publish_rejected', platform,
        installationId: deviceId, deviceName, source, operationId,
        entity: { kind: 'platform_video', id: platformId, label: title || undefined },
        detail: {
          reason: 'missing_file_name', remoteLibraryVideoId,
          contentId: contentId ?? null, platformUrl: platformUrl ?? null,
        },
      });
      res.status(422).json({ ok: false, reason: 'missing_file_name', remoteLibraryVideoId });
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
    if (err instanceof ConflictoDeIdentidadDeNube) {
      // La publicación ocurrió en la plataforma, pero la central no puede
      // asentarla sin elegir entre documentos ambiguos: no escribió nada. La
      // intención queda en el log append-only, para diagnóstico y
      // reconciliación -- el cliente descarta un 4xx de su cola.
      await recordAuditEvent({
        userId, type: 'publish_conflict', platform,
        installationId: deviceId, deviceName, source, operationId,
        entity: { kind: 'platform_video', id: platformId, label: title || fileName || undefined },
        detail: { reason: 'remote_identity_conflict', ...err.detalle, platformUrl: platformUrl ?? null },
      });
      res.status(409).json({ ok: false, reason: 'remote_identity_conflict', ...err.detalle });
      return;
    }
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

    const [backedUpSet, inRemoteLibrary] = await Promise.all([
      BACKUP_CANONICAL_READS
        ? getCanonicalSyncStatusBackedUpSet(userId, contentIds)
        : BackupFileModel.find({ userId, content_id: { $in: contentIds } }, { content_id: 1 }).lean()
            .then(rows => new Set(rows.map(f => f.content_id))),
      // storedFileName != null -- si no, "en la nube" quedaba en true para
      // siempre aunque el almacenamiento dinámico ya haya liberado los bytes
      // (ver remote-library-retention.service.ts): el doc/miniatura sobreviven
      // a propósito, pero eso ya no es "hay bytes reales en la nube".
      RemoteLibraryVideoModel.find({ userId, contentId: { $in: contentIds }, storedFileName: { $ne: null } }, { contentId: 1 }).lean(),
    ]);
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
    if (BACKUP_CANONICAL_READS) {
      const { total, lastSync } = await getCanonicalBackupStatus(userId);
      res.json({ total, lastSync });
      return;
    }
    const total  = await BackupFileModel.countDocuments({ userId });
    const latest = await BackupFileModel.findOne({ userId }, { updatedAt: 1 })
      .sort({ updatedAt: -1 }).lean();
    res.json({ total, lastSync: latest ? (latest as any).updatedAt : null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
