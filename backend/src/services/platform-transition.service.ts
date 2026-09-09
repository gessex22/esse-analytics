// Escritor único de estado de plataforma — Entrega 1.2 de
// docs/sync-convergence-plan-2026-09-08.md.
//
// PROBLEMA QUE RESUELVE. El mismo hecho ("¿este video está publicado en esta
// plataforma, con qué link?") vive en ~11 representaciones. Hoy lo escriben 6
// callers distintos, cada uno cubriendo un subconjunto distinto de esas
// representaciones, con su propia regla escrita a mano. Los bugs viven en los
// pares que nadie reconcilia: un `unlink` que solo tocaba `FileModel` dejaba
// el espejo de `backup_platform_videos` apuntando al archivo viejo, y el
// siguiente pull lo resucitaba (BUG-2026-09-07-01).
//
// LA DISTINCIÓN QUE FALTABA. Una ACCIÓN EXPLÍCITA del usuario sí puede
// degradar un `confirmed`; un push automático atrasado no. Hoy la protección
// de `confirmed` (BUG-2026-09-06-04) no puede distinguirlas, y por eso un
// descarte hecho en Electron se revierte solo en el siguiente tick. Todo lo
// que entra por acá es, por definición, una acción explícita.
//
// CLAVE DE MUTACIÓN: `content_id`, nunca un id local ni `file_name`. Ver la
// sección "Evidencia" del plan -- 100% de los archivos activos de los dos
// lados ya lo tienen, con índice único `{userId, content_id}`.

import { FileModel } from '../models/file.model';
import { BackupFileModel } from '../models/backup-file.model';
import { PlatformVideoModel, SyncPlatform } from '../models/platform-video.model';
import { BackupPlatformVideoModel } from '../models/backup-platform-video.model';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { randomUUID } from 'crypto';
import { PlatformTransitionOpModel } from '../models/platform-transition-op.model';

/**
 * Cuánto vale el lease que toma una request mientras aplica.
 *
 * Generoso a propósito: si vence mientras la request sigue trabajando, el
 * worker la puede tomar y las dos escriben. Que venza tiene que ser señal de
 * "el proceso se murió", no de "esto tardó".
 */
const LEASE_REQUEST_MS = 120_000;


/** Las 3 plataformas con estado propio comparable. 'facebook' es crosspost. */
export const TRANSITION_PLATFORMS = ['youtube', 'instagram', 'tiktok'] as const;
export type TransitionPlatform = (typeof TRANSITION_PLATFORMS)[number];

export type PlatformTransitionAction = 'unlink' | 'discard';

export interface PlatformTransitionResult {
  ok: boolean;
  /**
   * 'not_found' = no hay archivo con ese content_id para este usuario.
   * 'stale'     = la operación es anterior al último cambio de estado ya
   *               aplicado, así que se descarta (llegó tarde).
   */
  reason?: 'not_found' | 'stale' | 'conflict' | 'operation_mismatch' | 'in_progress';
  fileId?: string;
  platforms?: string[];
  platformsDiscarded?: string[];
  /** Revisión de esa plataforma: la vigente si hubo conflicto, la nueva si se aplicó. */
  version?: number;
  /** true = ya se había aplicado antes con este mismo operationId. */
  deduplicated?: boolean;
}

/**
 * Lo que queda escrito en `platform_claim.<plataforma>` al reclamar.
 *
 * Lleva la revisión, no solo el nombre de la operación, y esa es toda la
 * diferencia. Un claim que solo dice "la operación X reclamó esto" no caduca
 * nunca: `applyPlatformPublish` incrementa la revisión y no lo borra, así que
 * una entrega atrasada de X seguía reconociéndose como reanudación -- y
 * reanudar SALTEA la comprobación de `baseVersion` y el CAS, así que se
 * aplicaba sobre la revisión nueva y destruía la publicación que entró en el
 * medio.
 *
 * Con la revisión adentro el claim caduca solo: si alguien la movió, deja de
 * describir el presente. Ningún otro escritor tiene que acordarse de limpiarlo,
 * que es justamente lo que no se puede garantizar con 7 escritores.
 */
interface ClaimDePlataforma { op: string; rev: number }

function leerClaim(valor: unknown): ClaimDePlataforma | null {
  if (!valor || typeof valor !== 'object') return null;
  const c = valor as any;
  return (typeof c.op === 'string' && typeof c.rev === 'number') ? { op: c.op, rev: c.rev } : null;
}

// Nota: acá vivía `applyExplicitTransition`, un núcleo puro que calculaba los
// arrays resultantes en JS. Se eliminó al pasar a operadores atómicos de Mongo:
// calcular en JS y escribir con `$set` es read-modify-write del documento
// entero, y dos transiciones concurrentes sobre plataformas distintas se
// pisaban. La semántica ahora la expresan los propios `$pull`/`$addToSet`
// acotados por plataforma, y está cubierta contra el camino real en
// sync-integral.test.ts ("semántica: unlink deja la plataforma AUSENTE...").

// ---------------------------------------------------------------------------
// Orquestación — aplica la transición a TODAS las representaciones.
// ---------------------------------------------------------------------------

/**
 * Punto de entrada único para soltar o descartar una plataforma.
 *
 * Idempotente: repetir la misma llamada deja el mismo estado final (todas las
 * escrituras son "poner en este valor", no incrementos).
 *
 * `upload_history` y `audit_events` NO se tocan a propósito: son historial de
 * lo que pasó, no estado actual. Borrar de ahí falsearía la bitácora.
 */
/** Revisión vigente de una plataforma, para poder informarla en un conflicto. */
async function revisionVigente(fileId: any, platform: string): Promise<number> {
  const f = await FileModel.findById(fileId).select('platform_rev').lean();
  return ((f?.platform_rev ?? {}) as Record<string, number>)[platform] ?? 0;
}

export async function applyPlatformTransition(
  userId: string,
  // `platform` es SyncPlatform (incluye 'facebook'): el crosspost también se
  // puede desvincular, igual que hoy lo permite `unlinkPlatform`. Lo que
  // 'facebook' NO tiene es representación propia en Nube -- ver el guard de
  // TRANSITION_PLATFORMS más abajo.
  input: {
    contentId: string;
    platform: SyncPlatform;
    action: PlatformTransitionAction;
    /**
     * Revisión de ESA plataforma sobre la que el cliente basó su decisión.
     * Es la autoridad de precedencia: si ya no coincide con la del servidor,
     * alguien cambió el estado en el medio y esta operación quedó vieja.
     *
     * NO se usa el reloj del cliente para esto. Los relojes de los dispositivos
     * se desfasan (medido en este mismo repo: 5 h de deriva por un bug de zona
     * horaria), así que un cliente adelantado podría declararse "más nuevo" y
     * pisar un cambio que en realidad ocurrió después.
     *
     * Opcional por compatibilidad: sin `baseVersion` la operación se aplica
     * igual (comportamiento previo). La outbox SÍ debe mandarlo -- es lo que
     * la protege de aplicar fuera de orden.
     */
    baseVersion?: number;
    /**
     * Identidad de la operación. Con esto la entrega es idempotente de verdad
     * y una operación cortada a la mitad se puede reanudar.
     */
    operationId?: string;
    /** Informativo (diagnóstico). No decide precedencia. */
    stateChangedAt?: Date;
    /**
     * Token del ejecutor que YA tiene el lease de esta operación.
     *
     * Lo pasa el worker de reparación, que lo adquirió antes de llamar acá.
     * Sin esto, esta función generaba el suyo y -- al reanudar -- reemplazaba
     * el del worker sin preguntar: si la reanudación fallaba, el worker
     * intentaba liberar con un token que ya no era el vigente, no matcheaba
     * nada, y la operación quedaba trabada con un lease sin dueño y sin
     * registro de por qué.
     *
     * Una entrega HTTP no declara token: se lo tiene que ganar.
     */
    leaseOwner?: string;
  },
): Promise<PlatformTransitionResult> {
  const { contentId, platform, action, operationId, baseVersion } = input;

  // Resolución SOLO por content_id: si no está, se falla ruidosamente en vez
  // de caer a `file_name` (que ya causó daño real -- `final -` vs `FINAL -`
  // son dos documentos distintos, y `final  - sufre.mp4` con doble espacio
  // rompió el Calendario).
  const file = await FileModel.findOne({ userId, content_id: contentId });
  if (!file) return { ok: false, reason: 'not_found' };

  // ── Deduplicación persistente ───────────────────────────────────────────
  // Ya aplicada: se devuelve el resultado guardado sin volver a tocar nada.
  // Registrada pero incompleta: se REANUDA (las 5 escrituras son idempotentes).
  let opPrevia: any = null;
  if (operationId) {
    opPrevia = await PlatformTransitionOpModel.findOne({ userId, operationId }).lean();

    // P0-3: la clave identifica UNA operación concreta, no un permiso para
    // hacer cualquier cosa. Si llega la misma clave con otro payload, es un
    // error del cliente -- y aceptarlo sería peor que rechazarlo: podría
    // "reanudar" (o dar por completada) una operación que nunca se pidió.
    if (opPrevia && (
      opPrevia.contentId !== contentId ||
      opPrevia.platform !== platform ||
      opPrevia.action !== action ||
      (opPrevia.baseVersion ?? null) !== (baseVersion ?? null)
    )) {
      return { ok: false, reason: 'operation_mismatch', fileId: String(file._id) };
    }

    if (opPrevia?.status === 'completed') {
      return {
        ok: true,
        deduplicated: true,
        fileId: String(file._id),
        version: opPrevia.resultVersion,
        platforms: file.platforms ?? [],
        platformsDiscarded: file.platforms_discarded ?? [],
      };
    }
  }

  // Qué vínculos existían CUANDO ESTA OPERACIÓN empezó. Es el alcance de lo que
  // puede soltar: una publicación que entre después NO le pertenece.
  //
  // Se lee acá, antes del claim, y no a mitad de las proyecciones. Leerlo tarde
  // era un bug real: una publicación intercalada entre escrituras entraba en
  // esta lista y la transición terminaba desvinculándola, que es exactamente lo
  // que el alcance existe para impedir.
  const pvsDesvinculados = await PlatformVideoModel
    .find({ userId, linkedFileId: file._id, platform })
    .select('platformId')
    .lean();
  // Si la operación ya venía registrada, manda SU alcance: al reanudar, releer
  // la base devuelve vacío (el intento anterior ya soltó los vínculos) y la
  // reanudación no llegaría a completar las proyecciones que faltaban.
  //
  // Se pregunta si el alcance ESTÁ, no si tiene elementos. Un alcance vacío es
  // un alcance: describe una operación sobre un archivo con badge y sin
  // vínculo, que es un caso real. Tratarlo como "no se calculó" lo hacía
  // recalcular al reanudar, y se llevaba puesto cualquier vínculo aparecido
  // mientras tanto -- incluidos los que entran por los callers que todavía no
  // pasan por acá y por eso ni siquiera mueven la revisión.
  let idsVinculados: string[] = Array.isArray(opPrevia?.platformIds)
    ? opPrevia.platformIds
    : pvsDesvinculados.map(pv => pv.platformId).filter(Boolean);

  const revs = (file.platform_rev ?? {}) as Record<string, number>;
  const revActual: number | undefined = revs[platform];

  // Si el CAS ya se hizo NO se puede inferir del estado de la operación, ni de
  // `resultVersion`: las dos son escrituras SEPARADAS del CAS, y una caída en
  // el medio deja la revisión ya movida con la operación sin marca -- al
  // reintentar, esa operación se rechazaría a sí misma por `stale`.
  //
  // La señal vive en el MISMO documento que el CAS: `platform_claim` se escribe
  // en el propio update que incrementa la revisión, así que o están las dos
  // cosas o no está ninguna. Si el claim vigente lleva nuestro operationId,
  // esta operación ya reclamó y lo que falta es terminar de aplicar.
  // Se exige que el claim coincida en OPERACIÓN Y REVISIÓN. Si la revisión se
  // movió, el claim quedó viejo: esta operación reclamó un estado que ya no
  // existe, y lo que corresponde es que caiga por `stale`, no que se reanude.
  const claims = (file.platform_claim ?? {}) as Record<string, unknown>;
  const claimVigente = leerClaim(claims[platform]);
  const reanudando = !!operationId
    && claimVigente?.op === operationId
    && claimVigente?.rev === (revActual ?? 0);

  // ── Precedencia por revisión causal ─────────────────────────────────────
  // Solo se exige cuando el cliente declara sobre qué revisión trabajó. Al
  // reanudar NO se vuelve a exigir: esa operación ya ganó su lugar cuando se
  // registró, y su propio $inc movió (o va a mover) la revisión.
  if (baseVersion !== undefined && !reanudando && (revActual ?? 0) !== baseVersion) {
    return {
      ok: false,
      reason: 'stale',
      fileId: String(file._id),
      version: revActual ?? 0,
    };
  }

  const ahora = new Date();

  // Reserva la operación ANTES de tocar nada. Si el proceso se cae en el medio,
  // queda como `pending` y la próxima entrega la reanuda en vez de darla por
  // hecha o por nueva.
  // ── Reserva ATÓMICA de la operación ─────────────────────────────────────
  // Un `create` dentro de un try/catch que ignora el 11000 da por hecho que un
  // duplicado solo puede venir de otra entrega de la MISMA operación, y no lo
  // verifica. Con dos requests simultáneos los dos leen "no existe" -- así que
  // ninguno pasa por la validación de payload de más arriba, que solo corre si
  // ya había registro -- uno inserta y el otro se traga el 11000 y sigue como
  // si hubiera reservado. La clave terminaba identificando una operación
  // mientras OTRA, distinta, se aplicaba bajo su nombre.
  //
  // El upsert devuelve siempre el registro CANÓNICO: el que quedó, sea nuestro
  // o del que llegó primero. Todo lo que sigue se compara contra ese.
  // El token de ESTA aplicación. Request y worker usan el mismo protocolo: sin
  // eso, entre la reserva y el CAS existe una ventana en la que la operación ya
  // está registrada como `pending` y todavía no escribió su claim -- que es
  // exactamente el estado que el worker interpreta como "la superaron". Con el
  // worker cableado, esa ventana se vuelve observable.
  //
  // Si el caller ya tiene el lease (el worker), se usa EL SUYO: generar uno
  // nuevo acá le sacaría la operación de las manos a quien la está trabajando.
  const trajoLease = !!input.leaseOwner;
  const leaseOwner = operationId ? (input.leaseOwner ?? randomUUID()) : null;

  if (operationId) {
    let canonico: any = null;
    try {
      canonico = await PlatformTransitionOpModel.findOneAndUpdate(
        { userId, operationId },
        {
          $setOnInsert: {
            userId, operationId, contentId, platform, action,
            baseVersion, status: 'pending',
            // El alcance se congela acá, con la operación: ver el comentario del
            // campo en el modelo. Se guarda aunque esté vacío -- es la diferencia
            // entre "esta operación no abarca ningún vínculo" y "todavía no se
            // sabe", y confundirlas es lo que la hacía recalcular al reanudar.
            platformIds: idsVinculados ?? [],
            // El lease se toma EN LA MISMA escritura que reserva. Si fuera un
            // paso aparte quedaría una ventana -- chica, pero es justo la que
            // el worker sabe malinterpretar.
            leaseOwner, leaseUntil: new Date(Date.now() + LEASE_REQUEST_MS),
          },
        },
        { upsert: true, new: true },
      ).lean();
    } catch (err: any) {
      // Dos upserts simultáneos pueden chocar igual contra el índice único:
      // uno insertó entre el match y el insert del otro. El que pierde relee
      // -- no asume nada sobre lo que quedó.
      if (err?.code !== 11000) throw err;
      canonico = await PlatformTransitionOpModel.findOne({ userId, operationId }).lean();
    }

    if (!canonico) return { ok: false, reason: 'conflict', fileId: String(file._id) };

    // La clave identifica UNA operación concreta. Si lo que quedó reservado no
    // es lo que estamos pidiendo, es la otra la que vale -- y esta se rechaza
    // ANTES de tocar nada.
    if (
      canonico.contentId !== contentId ||
      canonico.platform !== platform ||
      canonico.action !== action ||
      (canonico.baseVersion ?? null) !== (baseVersion ?? null)
    ) {
      return { ok: false, reason: 'operation_mismatch', fileId: String(file._id) };
    }

    // Y el alcance que manda es el del registro canónico, no el que calculamos
    // recién: si otra entrega reservó primero, congeló SU foto, y esa es la que
    // define qué abarca la operación.
    if (Array.isArray(canonico.platformIds)) idsVinculados = canonico.platformIds;

    // ── CLAIM Y LEASE PRUEBAN COSAS DISTINTAS ────────────────────────────
    //
    //   El CLAIM (en `files`) prueba que esta operación sigue siendo
    //   causalmente VÁLIDA: es la dueña de la revisión vigente.
    //   El LEASE (acá) prueba QUÉ EJECUTOR puede trabajarla AHORA.
    //
    // Confundirlas fue un bug real: mientras `reanudando` autorizaba a tomar el
    // lease sin preguntar, el worker adquiría su token, llamaba acá, y esta
    // función se lo reemplazaba por el suyo. Si la reanudación fallaba, el
    // worker liberaba con un token que ya no era el vigente -- no matcheaba
    // nada, no quedaba `lastError` ni `nextAttemptAt`, y la operación quedaba
    // trabada con un lease sin dueño.
    //
    // Ahora: quien ya trajo el lease no lo re-adquiere, y quien no lo trajo
    // solo se lo queda si está libre o vencido. Si lo tiene otro, esta entrega
    // no trabaja la operación -- responde "todavía no".
    if (!trajoLease && String(canonico.leaseOwner ?? '') !== leaseOwner) {
      const adquirido = await PlatformTransitionOpModel.findOneAndUpdate(
        {
          userId, operationId,
          $or: [
            { leaseOwner: { $exists: false } }, { leaseOwner: null },
            { leaseUntil: { $exists: false } }, { leaseUntil: null },
            { leaseUntil: { $lte: new Date() } },
          ],
        },
        { $set: { leaseOwner, leaseUntil: new Date(Date.now() + LEASE_REQUEST_MS) } },
        { new: true },
      ).lean();
      if (!adquirido) {
        return { ok: false, reason: 'in_progress', fileId: String(file._id), version: revActual ?? 0 };
      }
    }
  }

  // ── Claim atómico de la revisión (compare-and-swap) ─────────────────────
  // Dos transiciones concurrentes sobre la misma plataforma no pueden ambas
  // "ganar": la segunda no matchea la revisión que leyó y se va como conflicto.
  // Sobre plataformas DISTINTAS no se estorban, porque `$inc` toca solo su
  // propia clave del mapa (por eso el mapa y no el array de antes, que se
  // reescribía entero y perdía el cambio del otro).
  //
  // Al reanudar se salta el CAS: la revisión ya se movió en el intento previo.
  let versionResultante = revActual ?? 0;
  if (!reanudando) {
    const filtroCas = revActual === undefined
      ? { _id: file._id, [`platform_rev.${platform}`]: { $exists: false } }
      : { _id: file._id, [`platform_rev.${platform}`]: revActual };

    const claimed = await FileModel.findOneAndUpdate(
      filtroCas,
      {
        $inc: { [`platform_rev.${platform}`]: 1 },
        $set: {
          [`platform_state_changed_at.${platform}`]: ahora,
          // El claim, en el MISMO update que la revisión: es lo que permite que
          // una reanudación se reconozca a sí misma después de una caída. Lleva
          // la revisión que este $inc va a producir, para que caduque solo
          // cuando otro escritor mueva la revisión.
          ...(operationId
            ? { [`platform_claim.${platform}`]: { op: operationId, rev: (revActual ?? 0) + 1 } }
            : {}),
        },
      },
      { new: true },
    ).lean();

    if (!claimed) {
      // El CAS lo puede perder otra entrega de ESTA MISMA operación (la outbox
      // reintentó antes de recibir la respuesta). Eso no es un conflicto: es una
      // entrega duplicada, y responderle 409 haría que el cliente creyera que su
      // operación quedó vieja y armara una nueva.
      if (operationId) {
        const relectura = await FileModel.findById(file._id).select('platform_rev platform_claim').lean();
        const claimTrasCas = leerClaim(((relectura?.platform_claim ?? {}) as Record<string, unknown>)[platform]);
        if (claimTrasCas?.op === operationId) {
          // El claim se escribe al RECLAMAR, no al terminar. Que lleve nuestro
          // operationId prueba que la gemela ganó el CAS, no que haya aplicado
          // nada todavía -- puede estar a mitad de las proyecciones, o haberse
          // caído ahí. Responder "deduplicada" ahí es mentir: el cliente marca
          // la fila como entregada y deja de reintentar sobre efectos
          // incompletos.
          //
          // "Deduplicada" significa "ya terminó". Mientras no terminó, la
          // respuesta honesta es "todavía no, volvé a intentar".
          const registro = await PlatformTransitionOpModel.findOne({ userId, operationId })
            .select('status resultVersion').lean();
          if (registro?.status !== 'completed') {
            return {
              ok: false,
              reason: 'in_progress',
              fileId: String(file._id),
              version: ((relectura?.platform_rev ?? {}) as Record<string, number>)[platform] ?? 0,
            };
          }
          return {
            ok: true,
            deduplicated: true,
            fileId: String(file._id),
            version: registro.resultVersion
              ?? ((relectura?.platform_rev ?? {}) as Record<string, number>)[platform] ?? 0,
          };
        }
      }
      return { ok: false, reason: 'conflict', fileId: String(file._id) };
    }
    versionResultante = ((claimed as any).platform_rev ?? {})[platform] ?? (revActual ?? 0) + 1;

    // (Acá vivía un re-afirmado del lease "porque ganar el CAS prueba
    // propiedad". Ya no hace falta ni corresponde: con la regla de arriba, solo
    // llega hasta el CAS quien tiene el lease, así que no hay nada que
    // re-afirmar -- y re-afirmarlo podría robárselo a un worker que lo tomó
    // porque este proceso se pasó de su vencimiento.)

    // Informativo. La señal autoritativa del claim es `platform_claim` en
    // FileModel, escrita atómicamente arriba; esto solo deja el resultado a mano
    // para la respuesta y para diagnóstico.
    if (operationId) {
      await PlatformTransitionOpModel.updateOne(
        { userId, operationId },
        { $set: { resultVersion: versionResultante } },
      );
    }
  } else {
    // Reanudación: la revisión vigente ES la que reclamó esta operación.
    versionResultante = revActual ?? 0;
  }

  // ── Escrituras ATÓMICAS POR PLATAFORMA ──────────────────────────────────
  // Antes esto calculaba los arrays completos en JS (con
  // `applyExplicitTransition`) y los escribía con `$set`. Eso es
  // read-modify-write del documento entero: dos transiciones concurrentes sobre
  // plataformas DISTINTAS leían la misma foto y la última en escribir borraba
  // el cambio de la otra. Lost update medido, no teórico -- el caso
  // "transiciones concurrentes en dos plataformas" lo reproduce.
  //
  // Con `$pull`/`$addToSet` acotados a esta plataforma, cada operación toca
  // solo lo suyo. Dos transiciones sobre la MISMA plataforma no compiten acá:
  // ya quedaron serializadas por el CAS de la revisión, más arriba.
  //
  // `platform_states` necesita dos pasos (no se puede `$pull` y `$addToSet` el
  // mismo campo en una sola actualización), y está bien: el CAS garantiza que
  // nadie más está tocando esta plataforma en el medio.
  const quitarDeFile: any = { platforms: platform, platform_states: { platform } };
  if (action === 'unlink') quitarDeFile.platforms_discarded = platform;

  // P0-2: TODAS las escrituras van condicionadas a que la revisión de esta
  // plataforma siga siendo la que esta operación reclamó. El CAS por sí solo no
  // alcanza: protege el claim y termina ahí, así que una publicación podía
  // entrar entre el claim y el `$pull` y la transición vieja la destruía igual.
  // Con el filtro, si alguien movió la revisión en el medio, estas escrituras
  // simplemente no matchean y la operación no pisa nada.
  const siSigueVigente = { _id: file._id, [`platform_rev.${platform}`]: versionResultante };

  const aplicado = await FileModel.updateOne(
    siSigueVigente,
    {
      $pull: quitarDeFile,
      // El reloj dedicado ya existe y el pull lo usa para desempatar. Moverlo
      // acá es lo que hace que una acción explícita le gane a un push viejo
      // que todavía no sabe de ella.
      $set: { platforms_updated_at: ahora },
    },
  );

  // Nadie matcheó: la revisión se movió mientras esta operación estaba en
  // curso. Se corta acá, sin aplicar el resto -- y sin marcar la operación como
  // completada, para que quede visible que no llegó a aplicarse.
  if ((aplicado.matchedCount ?? 0) === 0) {
    return { ok: false, reason: 'conflict', fileId: String(file._id), version: await revisionVigente(file._id, platform) };
  }

  if (action === 'discard') {
    await FileModel.updateOne(
      siSigueVigente,
      { $addToSet: { platforms_discarded: platform, platform_states: { platform, state: 'discarded' } } },
    );
  }

  // ¿La revisión que esta operación reclamó SIGUE siendo la vigente?
  //
  // Los sellos por documento (más abajo) protegen de que una escritura vieja
  // llegue tarde y pise una nueva. No protegen del caso inverso: que el mundo
  // cambie MIENTRAS esta operación avanza por sus proyecciones. Y ahí el sello
  // no puede ayudar, porque los otros escritores no sellan todo: un publish
  // mueve `files.platform_rev` pero nunca tocó `backup_files`, así que el guard
  // de esa proyección comparaba contra un valor que nadie había escrito y
  // dejaba pasar la escritura vieja.
  //
  // La autoridad es `files.platform_rev`. Se consulta entre proyecciones: si se
  // movió, esta operación perdió y se corta ANTES de tocar la siguiente
  // representación. Lo ya escrito queda a cargo de la reparación central (paso
  // 9); lo importante acá es no seguir destruyendo.
  const sigueVigente = async (): Promise<boolean> =>
    (await revisionVigente(file._id, platform)) === versionResultante;

  const cortadaPorConflicto = async (): Promise<PlatformTransitionResult> => ({
    ok: false,
    reason: 'conflict',
    fileId: String(file._id),
    version: await revisionVigente(file._id, platform),
  });

  // De acá en adelante cada proyección se SELLA con la versión de esta
  // operación y solo acepta escrituras cuya versión sea >= a la que ya tiene.
  // Sin esto el guard cubría únicamente el primer update de `files`: una
  // publicación que entrara DESPUÉS de ese update seguía siendo destruida por
  // la transición vieja en las otras representaciones.
  const noPisarMasNuevo = {
    $or: [
      { ['platform_rev.' + platform]: { $exists: false } },
      { ['platform_rev.' + platform]: { $lte: versionResultante } },
    ],
  };

  // 2) backup_files — la otra copia del mismo catálogo, mientras exista
  //    (se retira en la Entrega 5). Sin esto, el próximo `getBackupFiles`
  //    puede servir el estado viejo desde la colección equivocada.
  if (!(await sigueVigente())) return cortadaPorConflicto();

  const quitarDeBackup: any = { platforms: platform };
  if (action === 'unlink') quitarDeBackup.platforms_discarded = platform;
  await BackupFileModel.updateOne(
    { userId, content_id: contentId, ...noPisarMasNuevo },
    {
      $pull: quitarDeBackup,
      $set: {
        platforms_updated_at: ahora,
        ['platform_rev.' + platform]: versionResultante,
      },
    },
  );
  if (action === 'discard') {
    await BackupFileModel.updateOne(
      { userId, content_id: contentId, ['platform_rev.' + platform]: versionResultante },
      { $addToSet: { platforms_discarded: platform } },
    );
  }

  // 3) platformvideos — se desvincula el link real, pero NO se borra el
  //    documento: conserva platformId/métricas/fecha por si el video se vuelve
  //    a emparejar. Mismo criterio que ya usaba `unlinkPlatform`.

  // Acotado a los ids que existían cuando esta operación reclamó: una
  // publicación que entre después NO puede ser desvinculada por una transición
  // que nunca supo de ella.
  if (!(await sigueVigente())) return cortadaPorConflicto();

  // El guard de revisión va TAMBIÉN acá. El alcance dice QUÉ ids abarca la
  // operación; `linkVersion` dice si el vínculo que hay ahora es el mismo que
  // esta operación vio. Re-publicar el MISMO platformId a mitad de la
  // transición deja un vínculo nuevo bajo un id que sigue estando en el
  // alcance, y sin esta comparación la transición lo soltaba igual.
  await PlatformVideoModel.updateMany(
    {
      userId, linkedFileId: file._id, platform, platformId: { $in: idsVinculados },
      $or: [{ linkVersion: { $exists: false } }, { linkVersion: { $lte: versionResultante } }],
    },
    { $set: { linkedFileId: null, matchStatus: 'sin_match', linkVersion: versionResultante } },
  );

  // 4) backup_platform_videos — el espejo desde el que CADA escritorio
  //    reconstruye sus links locales al hacer pull.
  //
  //    TOMBSTONE, no borrado. Borrar la fila arreglaba a la PC que hizo el
  //    unlink (deja de resucitarse el vínculo) pero dejaba a las demás sin
  //    enterarse jamás: `pullPlatformVideosFromCloud` no elimina nunca filas
  //    locales que falten en la respuesta, así que un segundo dispositivo se
  //    quedaba el link para siempre. Marcada `unlinked`, ese pull tiene algo
  //    concreto que procesar.
  //
  //    Se conserva `content_id`: es lo que le dice a la otra PC de qué archivo
  //    despegar el vínculo (el platform_id solo no alcanza).
  //    Se marcan DOS conjuntos, porque ninguno alcanza solo:
  //      a) las filas del espejo que ya apuntaban a este content_id, y
  //      b) una fila por cada platformId que la central conoce como vinculado
  //         a este archivo (los PlatformVideoModel que se acaban de soltar).
  //
  //    (b) existe porque `updateMany` sin upsert no crea nada: si la fila
  //    histórica del espejo falta -- nunca se mirroreó, o la borró la versión
  //    anterior de este mismo servicio, que hacía deleteMany -- no quedaba
  //    ningún tombstone, y una PC vieja con el vínculo lo recreaba en su
  //    próximo push como si nada hubiera pasado.

  if (!(await sigueVigente())) return cortadaPorConflicto();

  await BackupPlatformVideoModel.updateMany(
    {
      userId, platform, content_id: contentId,
      platform_id: { $in: idsVinculados },
      $or: [{ link_version: { $exists: false } }, { link_version: { $lte: versionResultante } }],
    },
    {
      $set: {
        link_state: 'unlinked',
        link_updated_at: ahora,
        link_version: versionResultante,
        content_id: contentId,
        ...(operationId ? { operation_id: operationId } : {}),
      },
    },
  );

  for (const platformId of idsVinculados) {
    // El guard va TAMBIÉN acá. El `updateMany` de arriba compara `link_version`
    // pero este upsert no comparaba nada: escribía la lápida sobre lo que
    // hubiera, así que una transición vieja borraba un re-vínculo más nuevo que
    // ya había llegado.
    //
    // Con el guard en el filtro, si la fila existe con una revisión posterior el
    // update no matchea -- y el upsert intenta INSERTAR, chocando contra el
    // índice único {userId, platform, platform_id}. Ese choque no es un error:
    // es la prueba de que hay una fila más nueva que no hay que tocar.
    try {
      await BackupPlatformVideoModel.updateOne(
        {
          userId, platform, platform_id: platformId,
          $or: [{ link_version: { $exists: false } }, { link_version: { $lte: versionResultante } }],
        },
        {
        $set: {
          link_state: 'unlinked',
          link_updated_at: ahora,
          link_version: versionResultante,
          content_id: contentId,
          ...(operationId ? { operation_id: operationId } : {}),
        },
          // El índice único es {userId, platform, platform_id}, así que el
          // tombstone se crea por platformId. `local_updated_at` es requerido por
          // el schema y solo se fija al insertar: si la fila ya existía, su valor
          // real no se pisa.
          $setOnInsert: { local_updated_at: ahora, match_status: 'sin_match' },
        },
        { upsert: true },
      );
    } catch (err: any) {
      // 11000 = ya hay una fila para ese platformId, con una revisión posterior
      // a la de esta operación. Se la deja como está, a propósito.
      if (err?.code !== 11000) throw err;
    }
  }

  // 5) remote_library_videos — la copia de Nube. Solo si el video vive ahí y
  //    solo para las 3 plataformas que ese modelo conoce.
  if (!(await sigueVigente())) return cortadaPorConflicto();

  if ((TRANSITION_PLATFORMS as readonly string[]).includes(platform)) {
    // Mismo criterio atómico que arriba: operadores acotados a esta plataforma,
    // nunca reescribir los arrays enteros.
    const quitarDeNube: any = {
      platforms: platform,
      platformStates: { platform },
      // El link real también se va: es lo que distingue esta acción de un
      // simple cambio de badge. Acotado a los ids del alcance -- si entró una
      // publicación nueva, su link no es de esta operación.
      platformLinks: { platform, platformId: { $in: idsVinculados } },
    };
    if (action === 'unlink') quitarDeNube.platformsDiscarded = platform;

    const nubeNoPisarMasNuevo = {
      $or: [
        { ['platformRev.' + platform]: { $exists: false } },
        { ['platformRev.' + platform]: { $lte: versionResultante } },
      ],
    };
    await RemoteLibraryVideoModel.updateOne(
      { userId, contentId, ...nubeNoPisarMasNuevo },
      { $pull: quitarDeNube, $set: { ['platformRev.' + platform]: versionResultante } },
    );
    if (action === 'discard') {
      await RemoteLibraryVideoModel.updateOne(
        { userId, contentId, ['platformRev.' + platform]: versionResultante },
        { $addToSet: { platformsDiscarded: platform, platformStates: { platform, state: 'discarded' } } },
      );
    }
  }

  // Recién ahora la operación está completa en TODAS las proyecciones. Marcarla
  // antes sería mentir: una caída en el medio la dejaría como hecha y nadie la
  // reanudaría.
  if (operationId) {
    // Fenced: cerrar exige seguir siendo el dueño. Si el lease venció y otro
    // worker tomó la operación, esta escritura no matchea -- y está bien que no
    // matchee: el dueño actual es quien tiene que decidir cómo termina.
    const cerrada = await PlatformTransitionOpModel.updateOne(
      { userId, operationId, leaseOwner },
      {
        $set: { status: 'completed', completedAt: new Date(), resultVersion: versionResultante },
        $unset: { leaseOwner: '', leaseUntil: '' },
      },
    );
    if ((cerrada.matchedCount ?? 0) === 0) {
      console.warn(
        `[platform-transition] ${operationId}: se aplicó pero el lease ya no era nuestro. ` +
        `La cierra quien la tenga ahora.`,
      );
    }
  }

  // Se relee en vez de devolver lo calculado: con escrituras atómicas, el
  // estado final puede incluir cambios de otra plataforma aplicados en paralelo.
  // Devolver la foto vieja sería mentirle al cliente.
  const final = await FileModel.findById(file._id).select('platforms platforms_discarded').lean();

  return {
    ok: true,
    fileId: String(file._id),
    version: versionResultante,
    platforms: final?.platforms ?? [],
    platformsDiscarded: final?.platforms_discarded ?? [],
  };
}
