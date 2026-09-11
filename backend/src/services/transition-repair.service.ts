import { randomUUID } from 'crypto';
import { FileModel } from '../models/file.model';
import { BackupFileModel } from '../models/backup-file.model';
import { PlatformVideoModel } from '../models/platform-video.model';
import { BackupPlatformVideoModel, noEsMasNuevaEnEsteArchivo } from '../models/backup-platform-video.model';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { PlatformTransitionOpModel } from '../models/platform-transition-op.model';
import { applyPlatformTransition, TRANSITION_PLATFORMS } from './platform-transition.service';

// Reparación central de escrituras parciales — paso 9 de
// docs/sync-convergence-plan-2026-09-08.md.
//
// QUÉ PROBLEMA RESUELVE, Y CUÁL NO. Todo lo anterior evita que una operación
// superada siga DESTRUYENDO: se corta apenas nota que la revisión se movió. Lo
// que no resuelve es lo que ya escribió antes de notarlo. Una transición que
// alcanzó a mover `files` y `backup_files` y ahí perdió deja esas dos
// representaciones en un estado que ninguna otra cosa repara -- el publish que
// la superó re-arregla `files` (es lo que toca) pero nunca toca los badges de
// `backup_files`.
//
// Y su registro queda `pending`. Reprocesarlo con la misma operación y el mismo
// alcance congelado va a fallar SIEMPRE igual: su `baseVersion` describe un
// estado que ya no existe. Reintentar es exactamente lo que no hay que hacer.
//
// Por eso hay dos salidas, no una:
//
//   - Si la operación TODAVÍA es la dueña de la revisión vigente (se cortó por
//     una caída, no porque alguien la superara), se REANUDA: sus escrituras son
//     idempotentes y su alcance sigue siendo válido.
//   - Si la superaron, se REPARA hacia el estado canónico DE AHORA -- no se
//     vuelve a imponer lo que esa operación quería -- y se cierra como
//     `superseded`, que es una salida explícita y no un "seguí intentando".

/** Cuánto vale un lease por defecto. Suficiente para una pasada, corto para no trabar. */
const LEASE_MS = 30_000;
/** Después de esto una operación deja de reintentarse: algo estructural falla. */
const MAX_INTENTOS = 8;

export interface ResumenReparacion {
  revisadas: number;
  reanudadas: number;
  superadas: number;
  fallidas: number;
  pospuestas: number;
}

/**
 * Reclama una operación para este worker.
 *
 * El `leaseOwner` es un FENCING TOKEN, no una etiqueta de diagnóstico. Un
 * `leaseUntil` por sí solo no impide nada: el worker cuyo lease venció mientras
 * trabajaba sigue teniendo la operación en la mano y puede escribir su
 * resultado encima del worker nuevo que ya la tomó. Los dos se creen dueños y
 * gana el último en escribir. Con el token, cerrar/liberar exige demostrar que
 * uno sigue siendo el dueño.
 */
export async function tomarOperacion(
  userId: string,
  operationId: string,
  leaseOwner: string,
  leaseMs: number = LEASE_MS,
): Promise<boolean> {
  const ahora = new Date();
  const tomada = await PlatformTransitionOpModel.findOneAndUpdate(
    {
      userId, operationId, status: 'pending',
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lte: ahora } }],
    },
    {
      $set: { leaseOwner, leaseUntil: new Date(ahora.getTime() + leaseMs) },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
  return !!tomada;
}

/**
 * Cierra la operación. Solo el dueño del lease vigente puede hacerlo.
 *
 * Devuelve `false` -- sin escribir nada -- cuando el token ya no es el vigente:
 * ese worker llegó tarde y la operación es de otro.
 */
export async function cerrarOperacion(
  userId: string,
  operationId: string,
  leaseOwner: string,
  status: 'completed' | 'superseded' | 'failed',
  lastError: string | null,
): Promise<boolean> {
  const r = await PlatformTransitionOpModel.updateOne(
    { userId, operationId, leaseOwner },
    {
      $set: {
        status, completedAt: new Date(),
        lastError: lastError ?? null,
      },
      $unset: { leaseOwner: '', leaseUntil: '' },
    },
  );
  return (r.matchedCount ?? 0) > 0;
}

/**
 * Suelta la operación para que se reintente más tarde. Mismo fencing que arriba.
 *
 * Se posterga con `nextAttemptAt` en vez de reintentar en la misma pasada: si
 * lo que falló fue Mongo o la propia operación, insistir de inmediato solo
 * multiplica el mismo error.
 */
export async function liberarOperacion(
  userId: string,
  operationId: string,
  leaseOwner: string,
  lastError: string,
  esperaMs: number,
): Promise<boolean> {
  const r = await PlatformTransitionOpModel.updateOne(
    { userId, operationId, leaseOwner },
    {
      $set: { lastError: lastError.slice(0, 500), nextAttemptAt: new Date(Date.now() + esperaMs) },
      $unset: { leaseOwner: '', leaseUntil: '' },
    },
  );
  return (r.matchedCount ?? 0) > 0;
}

/**
 * Espera creciente CON JITTER, para no martillar cuando algo está roto.
 *
 * El jitter no es cosmético. Sin él, todo lo que falló junto -- que es lo
 * normal: una caída de Mongo tumba todas las operaciones en vuelo a la vez --
 * vuelve junto, falla junto, y se reprograma junto. Una caída breve se
 * convierte así en una tormenta periódica de reintentos sincronizados que se
 * mantiene sola. Se reparte sobre el 50% superior de la ventana: nunca antes de
 * lo que dice el backoff, nunca más del doble.
 */
export function esperaParaIntento(intentos: number): number {
  // Un solo techo, aplicado al valor final. Tenerlo dos veces (antes y después
  // del jitter) hacía que sacar el primero no cambiara nada -- o sea que no
  // había forma de saber cuál de los dos estaba sosteniendo el límite.
  const base = 60_000 * 2 ** Math.max(0, intentos - 1);
  return Math.min(Math.round(base * (1 + Math.random() * 0.5)), 3_600_000);
}

export interface MetricasReparacion {
  pendientes: number;
  fallidas: number;
  /** Antigüedad de la operación sin resolver más vieja. 0 si no hay ninguna. */
  edadMaximaMs: number;
}

/**
 * Lo que hay que mirar para saber si la cola está sana.
 *
 * `pendientes` sube y baja solo, así que por sí mismo no dice nada. Las dos
 * señales que importan son `fallidas` -- nadie las reintenta, así que si no las
 * mira una persona no existen -- y la EDAD de la más vieja, que es lo que
 * distingue "hay cola" de "hay cola TRABADA".
 */
export async function metricasDeReparacion(): Promise<MetricasReparacion> {
  const [pendientes, fallidas, masVieja] = await Promise.all([
    PlatformTransitionOpModel.countDocuments({ status: 'pending' }),
    PlatformTransitionOpModel.countDocuments({ status: 'failed' }),
    PlatformTransitionOpModel.findOne({ status: { $in: ['pending', 'failed'] } })
      .sort({ createdAt: 1 }).select('createdAt').lean(),
  ]);
  const creada = (masVieja as any)?.createdAt ? new Date((masVieja as any).createdAt).getTime() : null;
  return {
    pendientes, fallidas,
    edadMaximaMs: creada ? Math.max(0, Date.now() - creada) : 0,
  };
}

/**
 * Una pasada del worker.
 *
 * No corre en un timer propio -- se dispara desde donde ya se sabe que algo
 * cambió, igual que los flushes del lado del cliente.
 */
export async function repararTransicionesPendientes(limite = 50): Promise<ResumenReparacion> {
  const ahora = new Date();
  const resumen: ResumenReparacion = { revisadas: 0, reanudadas: 0, superadas: 0, fallidas: 0, pospuestas: 0 };

  const candidatas = await PlatformTransitionOpModel.find({
    status: 'pending',
    $and: [
      { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }, { nextAttemptAt: { $lte: ahora } }] },
      { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lte: ahora } }] },
    ],
  }).sort({ createdAt: 1 }).limit(limite).lean();

  for (const candidata of candidatas) {
    const { userId, operationId } = candidata as any;
    const leaseOwner = randomUUID();
    if (!(await tomarOperacion(userId, operationId, leaseOwner))) continue; // otro worker se adelantó
    resumen.revisadas++;

    try {
      const desenlace = await procesar(candidata as any, leaseOwner);
      if (desenlace === 'reanudada') resumen.reanudadas++;
      else if (desenlace === 'superada') resumen.superadas++;
      else resumen.fallidas++;
    } catch (err: any) {
      const intentos = ((candidata as any).attempts ?? 0) + 1;
      if (intentos >= MAX_INTENTOS) {
        await cerrarOperacion(userId, operationId, leaseOwner, 'failed', err?.message ?? 'error desconocido');
        resumen.fallidas++;
      } else {
        await liberarOperacion(userId, operationId, leaseOwner, err?.message ?? 'error', esperaParaIntento(intentos));
        resumen.pospuestas++;
      }
    }
  }

  return resumen;
}

type Desenlace = 'reanudada' | 'superada' | 'fallida';

async function procesar(op: any, leaseOwner: string): Promise<Desenlace> {
  const { userId, operationId, contentId, platform, action, baseVersion } = op;

  const file = await FileModel.findOne({ userId, content_id: contentId })
    .select('platform_rev platform_claim').lean();
  if (!file) {
    await cerrarOperacion(userId, operationId, leaseOwner, 'failed', 'el archivo ya no existe');
    return 'fallida';
  }

  const revActual = ((file.platform_rev ?? {}) as Record<string, number>)[platform] ?? 0;
  const claim = ((file.platform_claim ?? {}) as Record<string, any>)[platform];
  const sigueSiendoLaDuena = claim?.op === operationId && claim?.rev === revActual;

  // Se cortó por una caída, no porque alguien la superara: sus escrituras son
  // idempotentes y su alcance sigue valiendo. Se reanuda tal cual.
  if (sigueSiendoLaDuena) {
    // Se le pasa EL token del worker: si generara el suyo, esta función
    // reemplazaría el nuestro y no podríamos liberar la operación si falla.
    const r = await applyPlatformTransition(userId, {
      contentId, platform, action, operationId, baseVersion, leaseOwner,
    });
    if (r.ok) return 'reanudada';
    // Perdió entre que la miramos y la reintentamos. Cae al camino de abajo.
  }

  // La superaron. Lo que esa operación quería imponer ya no aplica; lo que hay
  // que arreglar es lo que alcanzó a escribir.
  await reproyectarPlataforma(userId, contentId, platform, op.platformIds ?? []);
  await cerrarOperacion(userId, operationId, leaseOwner, 'superseded',
    `superada: la revisión vigente (${revActual}) ya no es la que esta operación reclamó`);
  return 'superada';
}

/**
 * Lleva las proyecciones de UNA plataforma al estado canónico de AHORA.
 *
 * La autoridad es `FileModel`: `platforms` / `platforms_discarded` /
 * `platform_states` y su `platform_rev`. Todo lo demás es copia, y acá se la
 * vuelve a derivar en vez de intentar deshacer operación por operación -- que
 * es lo único que se puede hacer sin transacciones y sin un log de undo.
 *
 * Todo va sellado con la revisión vigente, así que esta reparación tampoco
 * puede pisar algo más nuevo que entre en el medio.
 */
export async function reproyectarPlataforma(
  userId: string,
  contentId: string,
  platform: string,
  /**
   * Ids del alcance congelado de la operación que se está reparando.
   *
   * Hace falta porque cuando el estado canónico es "desvinculado" NO se puede
   * enumerar qué limpiar mirando los vínculos vivos: si ya no queda ninguno, no
   * hay nada que enumerar, y los espejos con el link zombi quedan intactos. Se
   * usa la UNIÓN de tres fuentes -- este alcance, los vínculos actuales y los
   * espejos de este content_id.
   */
  idsDelAlcance: string[] = [],
): Promise<void> {
  const file = await FileModel.findOne({ userId, content_id: contentId }).lean();
  if (!file) return;

  const rev = ((file.platform_rev ?? {}) as Record<string, number>)[platform] ?? 0;
  const publicado = (file.platforms ?? []).includes(platform as any);
  const descartado = (file.platforms_discarded ?? []).includes(platform as any);
  const estado = (file.platform_states ?? []).find((s: any) => s.platform === platform);

  const noPisarMasNuevo = {
    $or: [
      { ['platform_rev.' + platform]: { $exists: false } },
      { ['platform_rev.' + platform]: { $lte: rev } },
    ],
  };

  // backup_files — badges planos.
  await BackupFileModel.updateOne(
    { userId, content_id: contentId, ...noPisarMasNuevo },
    {
      ...(publicado
        ? { $addToSet: { platforms: platform }, $pull: { platforms_discarded: platform } }
        : descartado
          ? { $addToSet: { platforms_discarded: platform }, $pull: { platforms: platform } }
          : { $pull: { platforms: platform, platforms_discarded: platform } }),
      $set: { ['platform_rev.' + platform]: rev },
    },
  );

  // remote_library_videos — la copia de Nube, solo para las plataformas que
  // ese modelo conoce.
  if ((TRANSITION_PLATFORMS as readonly string[]).includes(platform)) {
    const nubeNoPisarMasNuevo = {
      $or: [
        { ['platformRev.' + platform]: { $exists: false } },
        { ['platformRev.' + platform]: { $lte: rev } },
      ],
    };
    // Dos pasos: no se puede $pull y $addToSet el mismo campo a la vez.
    await RemoteLibraryVideoModel.updateOne(
      { userId, contentId, ...nubeNoPisarMasNuevo },
      {
        $pull: {
          platformStates: { platform },
          ...(publicado ? { platformsDiscarded: platform } : {}),
          ...(descartado ? { platforms: platform } : {}),
          ...(!publicado && !descartado ? { platforms: platform, platformsDiscarded: platform } : {}),
        },
        $set: { ['platformRev.' + platform]: rev },
      },
    );
    if (publicado || descartado) {
      await RemoteLibraryVideoModel.updateOne(
        { userId, contentId, ['platformRev.' + platform]: rev },
        {
          $addToSet: {
            ...(publicado ? { platforms: platform } : { platformsDiscarded: platform }),
            ...(estado ? { platformStates: { platform, state: estado.state } } : {}),
          },
        },
      );
    }
  }

  // ── Vínculos ────────────────────────────────────────────────────────────
  const vinculos = await PlatformVideoModel
    .find({ userId, platform, linkedFileId: file._id } as any)
    .select('platformId linkVersion platformUrl title publishedAt matchStatus').lean();

  if (publicado) {
    // Estado canónico positivo: los vínculos vivos son la verdad y el espejo
    // tiene que reflejarlos. Si quedó una lápida de una transición superada, se
    // levanta.
    //
    // Se escribe con CAS contra el `link_version` de cada fila, leído ANTES de
    // volver a mirar platformvideos: lo que se reasigne entre la primera lectura
    // y esa ya no aparece en la segunda, y lo que se reasigne después mueve el
    // `link_version` y el CAS no matchea. Comparar el sello de archivo acá no
    // sirve: si la fila se reasignó, es la revisión de OTRO archivo.
    const idsVivos = vinculos.map(v => v.platformId).filter(Boolean) as string[];
    const observadas = new Map((await BackupPlatformVideoModel
      .find({ userId, platform, platform_id: { $in: idsVivos } })
      .select('platform_id link_version link_state content_id').lean())
      .map((e: any) => [e.platform_id, e]));
    const siguenVivos = new Set((await PlatformVideoModel
      .find({ userId, platform, linkedFileId: file._id, platformId: { $in: idsVivos } } as any)
      .select('platformId').lean()).map((v: any) => v.platformId));
    for (const v of vinculos) {
      if (!v.platformId || !siguenVivos.has(v.platformId)) continue;
      const e: any = observadas.get(v.platformId);
      if (e && e.link_state === 'linked' && e.content_id === contentId) {
        // El mismo vínculo, vivo y en este archivo: no hay cambio que anunciar,
        // así que `link_version` no se mueve -- tampoco al repetir una reparación
        // que se cayó antes de cerrar. Pero la fila tiene que llevar la revisión
        // del estado que refleja: sellada con una menor, una escritura atrasada
        // de este mismo archivo todavía la supera. Y la URL, si le falta, sale
        // de platformvideos: es con lo que las PCs reconstruyen el link.
        //
        // "Si le falta" se decide en la propia escritura (`$ifNull`), no con la
        // foto que se leyó: si otro la completó en el medio, la suya se queda.
        //
        // Si en el medio la fila se soltó o se reasignó, no matchea: soltarla es
        // una escritura de este archivo con una revisión mayor, y reasignarla la
        // lleva a otro contenido.
        const url = (v as any).platformUrl;
        await BackupPlatformVideoModel.updateOne(
          {
            userId, platform, platform_id: v.platformId, content_id: contentId,
            ...noEsMasNuevaEnEsteArchivo(rev),
          },
          [{
            $set: {
              link_file_rev: { $literal: rev },
              ...(url ? { platform_url: { $ifNull: ['$platform_url', { $literal: url }] } } : {}),
            },
          }],
          { updatePipeline: true } as any,
        );
        continue;
      }
      try {
        await BackupPlatformVideoModel.updateOne(
          {
            userId, platform, platform_id: v.platformId,
            // Existía: CAS contra lo que se leyó. No existía: el filtro solo
            // matchea "sigue sin revisión", así que si otro la creó en el medio
            // el upsert choca contra el índice único, y se la deja.
            link_version: e && typeof e.link_version === 'number' ? e.link_version : { $exists: false },
          },
          {
            $set: { link_state: 'linked', link_updated_at: new Date(), link_file_rev: rev, content_id: contentId },
            $inc: { link_version: 1 },
            // Si la fila no está -- la versión anterior del servicio de
            // transiciones la borraba --, se recrea. Sin ella las PCs no
            // reconstruyen el vínculo, aunque la reparación se dé por cerrada.
            $setOnInsert: {
              local_updated_at: new Date(),
              match_status: (v as any).matchStatus ?? 'manual',
              platform_url: (v as any).platformUrl ?? null,
              title: (v as any).title ?? null,
              published_at: (v as any).publishedAt ?? null,
              file_name: (file as any).file_name ?? null,
            },
          },
          { upsert: true },
        );
      } catch (err: any) {
        // Otro la creó o la cambió en el medio: se la deja como está.
        if (err?.code !== 11000) throw err;
      }
    }
    return;
  }

  // Estado canónico NEGATIVO (desvinculado o descartado). Acá estaba el hueco:
  // la reparación sabía decir "esto está vinculado" y nada más, así que dejaba
  // vínculos zombis en `platformvideos`, en el espejo y en Nube -- y esos zombis
  // son justamente los que el próximo pull vuelve a convertir en links visibles
  // en todas las PCs.
  //
  // Los ids a limpiar salen de la UNIÓN de tres fuentes: mirar solo los
  // vínculos vivos no alcanza (si ya no queda ninguno no hay nada que
  // enumerar, y los espejos quedan intactos).
  const espejos = await BackupPlatformVideoModel
    .find({ userId, platform, content_id: contentId }).select('platform_id').lean();
  const ids = Array.from(new Set([
    ...idsDelAlcance,
    ...vinculos.map(v => v.platformId).filter(Boolean) as string[],
    ...espejos.map(e => e.platform_id).filter(Boolean) as string[],
  ]));

  await PlatformVideoModel.updateMany(
    {
      userId, platform, linkedFileId: file._id,
      $or: [{ linkVersion: { $exists: false } }, { linkVersion: { $lte: rev } }],
    } as any,
    { $set: { linkedFileId: null, matchStatus: 'sin_match', linkVersion: rev, linkVersionFileId: file._id } },
  );

  for (const platformId of ids) {
    // Toda fila de este contenido queda sellada con la revisión del estado que se
    // reproyecta: con una menor, una escritura atrasada de este mismo archivo
    // todavía la supera. Una lápida que ya está se queda así -- sigue suelta, y
    // `link_version` no se mueve: volver a ponerla anunciaría un cambio que no
    // ocurrió. Las que siguen vivas reciben la suya abajo.
    await BackupPlatformVideoModel.updateOne(
      {
        userId, platform, platform_id: platformId, content_id: contentId,
        ...noEsMasNuevaEnEsteArchivo(rev),
      },
      { $set: { link_file_rev: rev } },
    );
    try {
      await BackupPlatformVideoModel.updateOne(
        {
          // Solo una fila de ESTE contenido: si el vínculo ya es de otro
          // archivo, reparar este no puede ponerle una lápida.
          userId, platform, platform_id: platformId, content_id: contentId,
          ...noEsMasNuevaEnEsteArchivo(rev),
          // La lápida que ya está no se vuelve a poner: subiría la revisión sin
          // ningún cambio. El upsert choca contra el índice único y se la deja.
          link_state: { $ne: 'unlinked' },
        },
        {
          $set: {
            link_state: 'unlinked', link_updated_at: new Date(),
            link_file_rev: rev, content_id: contentId,
          },
          $inc: { link_version: 1 },
          $setOnInsert: { local_updated_at: new Date(), match_status: 'sin_match' },
        },
        { upsert: true },
      );
    } catch (err: any) {
      // Hay una fila más nueva para ese platformId: se la deja como está.
      if (err?.code !== 11000) throw err;
    }
  }

  // Y el link de Nube, que es lo que ven los clientes remotos.
  if ((TRANSITION_PLATFORMS as readonly string[]).includes(platform)) {
    await RemoteLibraryVideoModel.updateOne(
      {
        userId, contentId,
        $or: [
          { ['platformRev.' + platform]: { $exists: false } },
          { ['platformRev.' + platform]: { $lte: rev } },
        ],
      },
      { $pull: { platformLinks: { platform } }, $set: { ['platformRev.' + platform]: rev } },
    );
  }
}
