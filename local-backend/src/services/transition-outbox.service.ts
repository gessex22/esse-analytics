import { transitionOutboxRepo, TransitionOutboxEntry } from '../db/transition-outbox.repo';
import { platformRevisionRepo } from '../db/platform-revision.repo';
import { CENTRAL_API } from '../config';

const CENTRAL = CENTRAL_API;

// Los flushes se encadenan en vez de descartarse.
//
// El guard obvio ("si ya hay uno corriendo, no hagas nada") no sirve acá, y la
// diferencia se ve en el caso normal: `setPlatformLink` dispara el push de
// fondo (que flushea) y enseguida encola la desvinculación y flushea de nuevo.
// Con el guard, la segunda llamada se iba sin hacer nada Y SIN SABER si la
// primera había alcanzado a ver su fila -- `findPending` ya había leído su
// lote antes de que la fila existiera. El resultado era un aviso de "quedó
// pendiente" sobre una desvinculación que se estaba entregando bien.
//
// Encadenados, cada llamada recibe la promesa de SU pasada, que arranca recién
// cuando terminaron todas las anteriores: quien encoló antes de llamar tiene
// garantizado que su fila se miró.
let cola: Promise<ResultadoFlush> = Promise.resolve({ entregadas: 0, resueltas: 0, pendientes: 0 });

export interface ResultadoFlush {
  entregadas: number;
  resueltas: number;
  pendientes: number;
}

/**
 * Entrega a la central todo lo que quedó encolado.
 *
 * Se dispara desde los mismos puntos que el outbox de historial (al arrancar el
 * server y en cada `pushFilesToCloudInBackground`), nunca con un timer propio:
 * "algo cambió, sincronizá" ya cubre los momentos en que tiene sentido.
 *
 * DOS COSAS QUE NO SON OBVIAS:
 *
 * 1. Se reusa el `operation_id` de la fila, nunca uno nuevo. Un reintento con
 *    id nuevo es, para la central, otra operación -- y si la anterior sí se
 *    había aplicado (la respuesta se perdió en el camino, que es el caso normal
 *    de una outbox), los efectos se aplicarían dos veces. Con el mismo id la
 *    central responde `deduplicated` y no vuelve a tocar nada.
 *
 * 2. Se respeta el orden por (content_id, plataforma). Si una fila de esa clave
 *    no se pudo entregar, las siguientes de la MISMA clave se saltean: se
 *    decidieron sobre el resultado de aquella, así que entregarlas antes las
 *    haría llegar con una base que todavía no existe -- y la central las
 *    archivaría como conflicto, o sea perdidas, cuando en realidad solo habían
 *    llegado temprano. Las claves distintas siguen avanzando: un archivo trabado
 *    no puede frenar a los demás.
 */
export function flushTransitionOutbox(authHeader: string | undefined): Promise<ResultadoFlush> {
  if (!authHeader) {
    return Promise.resolve({ entregadas: 0, resueltas: 0, pendientes: transitionOutboxRepo.countPending() });
  }
  cola = cola.catch(() => undefined).then(() => pasada(authHeader));
  return cola;
}

async function pasada(authHeader: string): Promise<ResultadoFlush> {
  let entregadas = 0;
  let resueltas = 0;
  const trabadas = new Set<string>();

  {
    for (const entry of transitionOutboxRepo.findPending()) {
      const clave = `${entry.content_id}|${entry.platform}`;
      if (trabadas.has(clave)) continue;

      const resultado = await entregar(entry, authHeader);
      if (resultado === 'entregada') entregadas++;
      else if (resultado === 'resuelta') resueltas++;
      else trabadas.add(clave);

      // Un conflicto invalida también lo que venía detrás sobre la misma clave:
      // esas filas declaran una base que la operación archivada nunca produjo.
      if (resultado === 'resuelta') trabadas.add(clave);
    }
  }

  return { entregadas, resueltas, pendientes: transitionOutboxRepo.countPending() };
}

type ResultadoEntrega = 'entregada' | 'resuelta' | 'reintentar';

async function entregar(entry: TransitionOutboxEntry, authHeader: string): Promise<ResultadoEntrega> {
  let res: Response;
  try {
    res = await fetch(`${CENTRAL}/api/sync/platform-transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({
        contentId:   entry.content_id,
        platform:    entry.platform,
        action:      entry.action,
        operationId: entry.operation_id,
        baseVersion: entry.base_version,
      }),
    });
  } catch (err: any) {
    transitionOutboxRepo.markRetry(entry.id, err?.message ?? 'error de red');
    return 'reintentar';
  }

  if (res.ok) {
    const body = await res.json().catch(() => ({} as any));
    // La revisión que devuelve la central es la nueva verdad para esta
    // plataforma: sin guardarla, la próxima transición sobre el mismo archivo
    // declararía una base ya vencida y sería rechazada por atrasada.
    if (typeof body?.version === 'number') {
      platformRevisionRepo.set(entry.content_id, entry.platform, body.version);
    }
    transitionOutboxRepo.markDelivered(entry.id);
    return 'entregada';
  }

  // 409: llegó tarde. La central manda la revisión vigente -- se guarda, para
  // que lo que el usuario decida de acá en más parta del estado real.
  if (res.status === 409) {
    const body = await res.json().catch(() => ({} as any));
    if (typeof body?.version === 'number') {
      platformRevisionRepo.set(entry.content_id, entry.platform, body.version);
    }
    transitionOutboxRepo.markResolved(entry.id, 'conflict', `HTTP 409 ${body?.reason ?? ''}`.trim());
    console.warn(
      `[transition-outbox] ${entry.action} de ${entry.platform} descartada por llegar tarde ` +
      `(base ${entry.base_version}, vigente ${body?.version ?? '?'}).`,
    );
    return 'resuelta';
  }

  // 401 y 429 son transitorios (token vencido, rate limit); 5xx también. El
  // resto de los 4xx los va a seguir rechazando siempre.
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
    const detalle = await res.text().catch(() => '');
    transitionOutboxRepo.markResolved(entry.id, 'failed', `HTTP ${res.status} ${detalle}`.trim());
    return 'resuelta';
  }

  transitionOutboxRepo.markRetry(entry.id, `HTTP ${res.status}`);
  return 'reintentar';
}
