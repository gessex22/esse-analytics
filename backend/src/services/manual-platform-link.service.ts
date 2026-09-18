import { randomUUID } from 'crypto';
import { FileModel } from '../models/file.model';
import { BackupFileModel } from '../models/backup-file.model';
import { PlatformVideoModel, SyncPlatform } from '../models/platform-video.model';
import { ManualLinkOpModel } from '../models/manual-link-op.model';
import { applyPlatformTransition } from './platform-transition.service';
import { applyPlatformPublish } from '../controllers/backup.controller';

const REQUEST_LEASE_MS = 120_000;
const WORKER_LEASE_MS = 30_000;

export interface ManualLinkInput {
  operationId: string;
  targetFileId?: string;
  targetContentId?: string;
  platform: SyncPlatform;
  platformId: string;
  platformUrl?: string | null;
  title?: string | null;
  publishedAt?: Date | null;
  matchStatus?: string;
}

export interface ManualLinkResult {
  ok: boolean;
  reason?: 'not_found' | 'missing_identity' | 'stale' | 'operation_mismatch' | 'in_progress';
  operationId?: string;
  version?: number;
  deduplicated?: boolean;
}

function revision(file: any, platform: string): number {
  return ((file?.platform_rev ?? {}) as Record<string, number>)[platform] ?? 0;
}

/**
 * Compara un campo opcional del payload contra lo que la operación ya
 * congeló. Ausente en el request nuevo = compatible: varios callers no
 * reenvían todos los campos en cada llamada (ej. `applyManualPlatformLink`
 * puede recibir metadata parcial), y exigir que coincida un campo que ni
 * siquiera se mandó rechazaría reintentos legítimos.
 */
function mismoCampoOpcional(deLaOperacion: unknown, delInput: unknown): boolean {
  if (delInput === undefined) return true;
  return String(deLaOperacion ?? '') === String(delInput ?? '');
}

function mismaFechaOpcional(deLaOperacion: unknown, delInput: Date | null | undefined): boolean {
  if (delInput === undefined) return true;
  const a = deLaOperacion ? new Date(deLaOperacion as any).getTime() : 0;
  const b = delInput ? new Date(delInput).getTime() : 0;
  return a === b;
}

/**
 * El `operationId` identifica UNA operación concreta, no un permiso para
 * mover cualquier cosa bajo ese nombre. Antes solo se comparaba el destino:
 * reusar la misma clave con otra URL, título, fecha o `matchStatus` se
 * aceptaba en silencio y esos campos quedaban con lo que trajo la PRIMERA
 * llamada -- una segunda entrega con datos distintos (bug de cliente, o un
 * reintento con el payload mal armado) parecía "deduplicada" sin serlo.
 */
function mismoPayload(op: any, input: ManualLinkInput): boolean {
  const mismoDestino = input.targetFileId !== undefined
    ? op.targetFileId === String(input.targetFileId)
    : op.targetContentId !== undefined && op.targetContentId === input.targetContentId;
  return mismoDestino
    && op.platform === input.platform
    && op.platformId === input.platformId
    && mismoCampoOpcional(op.platformUrl, input.platformUrl)
    && mismoCampoOpcional(op.title, input.title)
    && mismaFechaOpcional(op.publishedAt, input.publishedAt)
    && mismoCampoOpcional(op.matchStatus, input.matchStatus);
}

async function reservar(
  userId: string,
  operationId: string,
  input: ManualLinkInput,
  leaseOwner: string,
): Promise<any | null> {
  // La foto del vínculo se toma ANTES de leer el destino. Una publicación que
  // entre entre ambas lecturas hará que la comprobación previa al unlink la
  // detecte; no puede convertirse retroactivamente en la fuente de esta acción.
  const vinculo: any = await PlatformVideoModel.findOne({
    userId, platform: input.platform, platformId: input.platformId,
  }).lean();
  const targetQuery = input.targetFileId
    ? { _id: input.targetFileId, userId }
    : input.targetContentId
      ? { content_id: input.targetContentId, userId }
      : null;
  if (!targetQuery) return null;
  const target: any = await FileModel.findOne(targetQuery).lean();
  if (!target?.content_id) return null;

  const sourceId = vinculo?.linkedFileId ? String(vinculo.linkedFileId) : null;
  const source: any = sourceId && sourceId !== String(target._id)
    ? await FileModel.findOne({ _id: sourceId, userId }).lean()
    : null;
  if (source && !source.content_id) return { preparationError: 'missing_identity' };

  try {
    return await ManualLinkOpModel.findOneAndUpdate(
      { userId, operationId },
      {
        $setOnInsert: {
          userId, operationId,
          platform: input.platform, platformId: input.platformId,
          platformUrl: input.platformUrl ?? vinculo?.platformUrl ?? null,
          title: input.title ?? vinculo?.title ?? null,
          publishedAt: input.publishedAt ?? vinculo?.publishedAt ?? null,
          matchStatus: input.matchStatus ?? 'manual',
          targetFileId: String(target._id), targetContentId: target.content_id,
          targetFileName: target.file_name,
          sourceFileId: source ? String(source._id) : null,
          sourceContentId: source?.content_id ?? null,
          sourceBaseVersion: source ? revision(source, input.platform) : null,
          status: 'pending', leaseOwner,
          leaseUntil: new Date(Date.now() + REQUEST_LEASE_MS),
          // Primera adquisición del lease: arranca en 1, no en 0, para que
          // "nunca hubo claim" (fence 0 implícito en cualquier lectura vieja)
          // nunca se confunda con una adquisición real.
          fence: 1,
        },
      },
      { upsert: true, new: true },
    ).lean();
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    return ManualLinkOpModel.findOne({ userId, operationId }).lean();
  }
}

/**
 * Cierra la operación. Fenced igual que `reclamarVinculo`: `leaseOwner` sigue
 * en el filtro (diagnóstico, y protege el caso en que `fence` se reutilice
 * entre callers), pero `fence` es la prueba real de que sigue siendo el
 * dueño -- si otra ejecución ya avanzó el contador (perdió el lease y alguien
 * más lo retomó), ninguna de las dos escrituras matchea y esta llamada no le
 * borra el claim ni el cierre al dueño vigente.
 */
async function cerrar(
  op: any,
  leaseOwner: string,
  status: 'completed' | 'superseded' | 'failed',
  extra: Record<string, any> = {},
): Promise<void> {
  await PlatformVideoModel.updateOne(
    {
      userId: op.userId, platform: op.platform, platformId: op.platformId,
      'manualLinkClaim.operationId': op.operationId,
      'manualLinkClaim.leaseOwner': leaseOwner,
      'manualLinkClaim.fence': op.fence,
    },
    { $unset: { manualLinkClaim: '' } },
  );
  await ManualLinkOpModel.updateOne(
    { userId: op.userId, operationId: op.operationId, leaseOwner, fence: op.fence },
    {
      $set: { status, completedAt: new Date(), ...extra },
      $unset: { leaseOwner: '', leaseUntil: '' },
    },
  );
}

async function reclamarVinculo(op: any, leaseOwner: string): Promise<boolean> {
  const dueñosPermitidos = [null, op.sourceFileId, op.targetFileId].filter((v, i, a) => a.indexOf(v) === i);
  try {
    const r: any = await PlatformVideoModel.findOneAndUpdate(
      {
        userId: op.userId, platform: op.platform, platformId: op.platformId,
        $and: [
          { $or: [
            { manualLinkClaim: { $exists: false } }, { manualLinkClaim: null },
            // El mismo `operationId` no alcanza: una ejecución vieja (lease
            // vencido) y la que la reemplazó comparten ese nombre. Solo se
            // puede reclamar/re-reclamar el claim si el `fence` propio es al
            // menos tan nuevo como el que ya está escrito -- una ejecución con
            // un `fence` menor nunca pisa a una más nueva.
            { 'manualLinkClaim.operationId': op.operationId, 'manualLinkClaim.fence': { $lte: op.fence } },
          ] },
          { $or: [
            { linkedFileId: { $exists: false } },
            { linkedFileId: { $in: dueñosPermitidos } },
          ] },
        ],
      },
      {
        $set: {
          manualLinkClaim: { operationId: op.operationId, targetFileId: op.targetFileId, leaseOwner, fence: op.fence },
        },
        $setOnInsert: {
          userId: op.userId, platform: op.platform, platformId: op.platformId,
          platformUrl: op.platformUrl ?? '', title: op.title ?? '',
          publishedAt: op.publishedAt ?? new Date(), matchStatus: op.matchStatus ?? 'manual',
        },
      },
      { upsert: true, new: true },
    ).lean();
    return !!r;
  } catch (err: any) {
    // El índice único demuestra que existe el mismo video, pero ya no cumple
    // el dueño/claim congelado por esta operación.
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function procesar(op: any, leaseOwner: string): Promise<ManualLinkResult> {
  const { userId, operationId, platform, platformId } = op;

  // El `op.fence` que esta ejecución trae es el que creía vigente al empezar.
  // Releer ANTES de tocar cualquier colección: si el lease se venció mientras
  // esperaba su turno (event loop, latencia real) y otra ejecución ya lo
  // retomó -- status ya no es 'pending', o el fence ya es otro --, esta
  // ejecución está superada. Sin este chequeo, `reclamarVinculo` de abajo
  // podía reclamar un claim que la ejecución nueva YA HABÍA CERRADO (unset):
  // "no hay claim" también matchea "no hay claim porque ya se resolvió", y una
  // ejecución vieja resucitaba un claim sobre una operación ya completada.
  //
  // Esta relectura reduce la ventana, pero no la cierra: `ManualLinkOpModel`
  // (acá) y `PlatformVideoModel` (en `reclamarVinculo`, abajo) son colecciones
  // distintas sin transacción entre ambas. Nada impide que, ENTRE esta lectura
  // y la escritura de `reclamarVinculo`, otra ejecución re-adquiera el lease
  // (fence nuevo), reclame, transicione, publique y cierre la operación entera
  // -- unset del claim incluido. Esta ejecución vieja llegaría a
  // `reclamarVinculo` con la vía libre de "no hay claim" y lo resucitaría. Por
  // eso hay una segunda prueba, después de escribir, más abajo.
  const opVigente: any = await ManualLinkOpModel.findOne({ userId, operationId, status: 'pending' });
  if (!opVigente || opVigente.fence !== op.fence) {
    return { ok: false, reason: 'stale', operationId };
  }

  if (!(await reclamarVinculo(op, leaseOwner))) {
    await cerrar(op, leaseOwner, 'superseded', { lastError: 'el vínculo ya pertenece a otra operación' });
    return { ok: false, reason: 'stale', operationId };
  }

  // Cierra la ventana de arriba: recién escribió el claim en PlatformVideoModel
  // -- posiblemente sobre un documento cuya operación en ManualLinkOpModel otra
  // ejecución ya completó y cerró en el medio. Releer acá, DESPUÉS de escribir,
  // es la única prueba real de que esta ejecución sigue siendo pending con el
  // fence propio. Si no lo es, se deshace SOLO el claim que esta llamada
  // acaba de escribir (fence propio en el filtro protege contra pisar el de
  // quien haya ganado después) y no se avanza a tocar ninguna transición ni
  // publicación real.
  const opTrasReclamo: any = await ManualLinkOpModel.findOne({ userId, operationId, status: 'pending', fence: op.fence }).lean();
  if (!opTrasReclamo) {
    await PlatformVideoModel.updateOne(
      {
        userId, platform, platformId,
        'manualLinkClaim.operationId': operationId,
        'manualLinkClaim.leaseOwner': leaseOwner,
        'manualLinkClaim.fence': op.fence,
      },
      { $unset: { manualLinkClaim: '' } },
    );
    return { ok: false, reason: 'stale', operationId };
  }

  if (op.sourceContentId && op.sourceFileId !== op.targetFileId) {
    const actual: any = await PlatformVideoModel.findOne({ userId, platform, platformId })
      .select('linkedFileId').lean();
    const actualId = actual?.linkedFileId ? String(actual.linkedFileId) : null;
    // Si ya apunta a un tercer archivo, una operación posterior ganó. No se
    // usa ese vínculo como nueva fuente ni se lo recupera hacia el destino.
    if (actualId && actualId !== op.sourceFileId && actualId !== op.targetFileId) {
      await cerrar(op, leaseOwner, 'superseded', { lastError: 'el vínculo fue movido por una operación posterior' });
      return { ok: false, reason: 'stale', operationId };
    }

    const retirada = await applyPlatformTransition(userId, {
      contentId: op.sourceContentId,
      platform,
      action: 'unlink',
      operationId: `${operationId}:source`,
      baseVersion: op.sourceBaseVersion ?? 0,
    });
    if (!retirada.ok) {
      if (retirada.reason === 'stale' || retirada.reason === 'operation_mismatch') {
        await cerrar(op, leaseOwner, 'superseded', { lastError: retirada.reason });
        return { ok: false, reason: retirada.reason, operationId, version: retirada.version } as ManualLinkResult;
      }
      throw new Error(`no se pudo retirar el vínculo anterior: ${retirada.reason ?? 'desconocido'}`);
    }
  }

  // La transición de origen pudo soltarlo. Cualquier tercer dueño en este
  // punto es posterior y gana; el vínculo manual no lo puede recuperar.
  const vigente: any = await PlatformVideoModel.findOne({ userId, platform, platformId })
    .select('linkedFileId').lean();
  const vigenteId = vigente?.linkedFileId ? String(vigente.linkedFileId) : null;
  if (vigenteId && vigenteId !== op.targetFileId) {
    await cerrar(op, leaseOwner, 'superseded', { lastError: 'el vínculo cambió antes de publicar el destino' });
    return { ok: false, reason: 'stale', operationId };
  }

  const publicado = await applyPlatformPublish(userId, {
    platform, platformId,
    platformUrl: op.platformUrl,
    fileName: op.targetFileName,
    contentId: op.targetContentId,
    title: op.title,
    publishedAt: op.publishedAt ?? undefined,
    matchStatus: op.matchStatus ?? 'manual',
    manualLink: true,
    manualOperationId: operationId,
    manualLeaseOwner: leaseOwner,
    manualFence: op.fence,
  });

  if (publicado.projected === false) {
    // El claim se perdió mientras applyPlatformPublish ya había alcanzado a
    // confirmar FileModel. Se compensa la escritura parcial PROPIA -- nunca la
    // de otro. `fence` en el filtro, no solo `leaseOwner`: sin él, un worker
    // que perdió el lease pero cuyo `leaseOwner` externo coincide por
    // casualidad (o que corre justo antes de que el reemplazo lo pise) se
    // creería vigente y compensaría sobre un claim que ya es de otra
    // ejecución -- exactamente el mismo trío operationId/leaseOwner/fence que
    // exige toda proyección manual.
    const sigueConLease = await ManualLinkOpModel.exists({
      userId, operationId, leaseOwner, status: 'pending', fence: op.fence,
    });
    if (!sigueConLease) return { ok: false, reason: 'in_progress', operationId };

    // Si el vínculo vigente YA apunta al destino, una publicación (automática,
    // sin `manualOperationId`) ganó esa misma carrera y proyectó lo mismo que
    // esta operación quería -- el badge `confirmed` que dejó el `$inc` de esta
    // llamada está justificado por ESA publicación, no es una media verdad.
    // Compensar acá (desvincular) no arregla nada propio: borra la publicación
    // ajena que llegó primero. No hay nada que deshacer.
    const vinculoVigente: any = await PlatformVideoModel.findOne({ userId, platform, platformId })
      .select('linkedFileId').lean();
    const vinculoVigenteId = vinculoVigente?.linkedFileId ? String(vinculoVigente.linkedFileId) : null;
    if (vinculoVigenteId !== op.targetFileId && publicado.revision !== undefined) {
      // `publicado.revision` es la revisión que ESTA llamada causó, no la
      // vigente al leer acá: usar la vigente mezclaba esta escritura con
      // cualquiera que haya entrado después y la transición terminaba
      // desvinculando también a esa otra. Con la propia, el CAS de
      // applyPlatformTransition solo aplica si nadie movió la revisión desde
      // entonces -- si alguien lo hizo (otra publicación real, al mismo u
      // otro destino), la compensación no matchea y no toca nada.
      await applyPlatformTransition(userId, {
        contentId: op.targetContentId, platform, action: 'unlink',
        operationId: `${operationId}:target-compensation`, baseVersion: publicado.revision,
      });
    }
    await cerrar(op, leaseOwner, 'superseded', { lastError: 'el claim se perdió durante la publicación' });
    return { ok: false, reason: 'stale', operationId };
  }

  const target: any = await FileModel.findOne({ userId, content_id: op.targetContentId }).lean();
  const version = revision(target, platform);
  // applyPlatformPublish sella backup_files, pero no crea el badge plano: esa
  // colección sigue siendo parte del contrato mientras exista.
  await BackupFileModel.updateOne(
    {
      userId, content_id: op.targetContentId,
      $or: [
        { [`platform_rev.${platform}`]: { $exists: false } },
        { [`platform_rev.${platform}`]: { $lte: version } },
      ],
    },
    {
      $addToSet: { platforms: platform },
      $pull: { platforms_discarded: platform },
      $set: { [`platform_rev.${platform}`]: version },
    },
  );

  await cerrar(op, leaseOwner, 'completed', { resultVersion: version, lastError: null });
  return { ok: true, operationId, version, deduplicated: false };
}

export async function applyManualPlatformLink(
  userId: string,
  input: ManualLinkInput,
  existingLeaseOwner?: string,
): Promise<ManualLinkResult> {
  const operationId = input.operationId;
  const leaseOwner = existingLeaseOwner ?? randomUUID();
  let op: any = await ManualLinkOpModel.findOne({ userId, operationId }).lean();

  if (!op) op = await reservar(userId, operationId, input, leaseOwner);
  if (!op) return { ok: false, reason: 'not_found', operationId };
  if (op.preparationError === 'missing_identity') {
    return { ok: false, reason: 'missing_identity', operationId };
  }
  if (!mismoPayload(op, input)) return { ok: false, reason: 'operation_mismatch', operationId };
  if (op.status === 'completed') {
    return { ok: true, operationId, version: op.resultVersion, deduplicated: true };
  }
  if (op.status === 'superseded' || op.status === 'failed') {
    return { ok: false, reason: 'stale', operationId, version: op.resultVersion };
  }

  if (!existingLeaseOwner && String(op.leaseOwner ?? '') !== leaseOwner) {
    const tomada: any = await ManualLinkOpModel.findOneAndUpdate(
      {
        userId, operationId, status: 'pending',
        $or: [
          { leaseOwner: { $exists: false } }, { leaseOwner: null },
          { leaseUntil: { $exists: false } }, { leaseUntil: null },
          { leaseUntil: { $lte: new Date() } },
        ],
      },
      // Re-adquirir el lease es una adquisición: avanza el fence. Es lo que
      // permite que una ejecución anterior, colgada con el `op` viejo en la
      // mano, se reconozca a sí misma como superada en vez de pisar a esta.
      { $set: { leaseOwner, leaseUntil: new Date(Date.now() + REQUEST_LEASE_MS) }, $inc: { fence: 1 } },
      { new: true },
    ).lean();
    if (!tomada) return { ok: false, reason: 'in_progress', operationId };
    op = tomada;
  }

  try {
    return await procesar(op, leaseOwner);
  } catch (err: any) {
    await ManualLinkOpModel.updateOne(
      { userId, operationId, leaseOwner, fence: op.fence },
      {
        $set: { lastError: String(err?.message ?? err).slice(0, 500), nextAttemptAt: new Date(Date.now() + 60_000) },
        $unset: { leaseOwner: '', leaseUntil: '' },
      },
    );
    throw err;
  }
}

/** Reanuda operaciones padre cuyo request cayó entre retirar B y publicar A. */
export async function repararVinculosManualesPendientes(limite = 25): Promise<void> {
  const ahora = new Date();
  const ops: any[] = await ManualLinkOpModel.find({
    status: 'pending',
    $and: [
      { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: ahora } }] },
      { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lte: ahora } }] },
    ],
  }).sort({ createdAt: 1 }).limit(limite).lean();

  for (const candidata of ops) {
    const leaseOwner = randomUUID();
    const op: any = await ManualLinkOpModel.findOneAndUpdate(
      {
        _id: candidata._id, status: 'pending',
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lte: ahora } }],
      },
      {
        $set: { leaseOwner, leaseUntil: new Date(Date.now() + WORKER_LEASE_MS) },
        // La toma del worker también es una adquisición: avanza el fence,
        // igual que la re-adquisición de applyManualPlatformLink.
        $inc: { attempts: 1, fence: 1 },
      },
      { new: true },
    ).lean();
    if (!op) continue;
    try {
      await procesar(op, leaseOwner);
    } catch (err: any) {
      const attempts = (op.attempts ?? 0);
      if (attempts >= 8) {
        await PlatformVideoModel.updateOne(
          {
            userId: op.userId, platform: op.platform, platformId: op.platformId,
            'manualLinkClaim.operationId': op.operationId,
            'manualLinkClaim.leaseOwner': leaseOwner,
            'manualLinkClaim.fence': op.fence,
          },
          { $unset: { manualLinkClaim: '' } },
        );
      }
      await ManualLinkOpModel.updateOne(
        { _id: op._id, leaseOwner, fence: op.fence },
        attempts >= 8
          ? { $set: { status: 'failed', completedAt: new Date(), lastError: String(err?.message ?? err).slice(0, 500) }, $unset: { leaseOwner: '', leaseUntil: '' } }
          : { $set: { lastError: String(err?.message ?? err).slice(0, 500), nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** Math.max(0, attempts - 1)) }, $unset: { leaseOwner: '', leaseUntil: '' } },
      );
    }
  }
}
