import { repararTransicionesPendientes, metricasDeReparacion, ResumenReparacion } from './transition-repair.service';

// Disparador del worker de reparación (ver transition-repair.service.ts).
//
// POR QUÉ HAY BARRIDO PERIÓDICO Y NO SOLO DISPARO POR EVENTO. El caso que la
// reparación existe para cubrir es justamente el que NO genera un evento
// después: el proceso se cayó a mitad de una transición. Si el único disparador
// fuera "algo pasó por HTTP", la última operación de un proceso que murió se
// quedaría esperando a que alguien más haga algo -- y en una instalación de un
// solo usuario eso puede ser al día siguiente.
//
// El disparo oportunista es un ADICIONAL para que el caso normal se repare en
// segundos, no un sustituto.

/** Cada cuánto barre. Corto no ayuda: casi todas las pasadas no encuentran nada. */
const INTERVALO_MS = 5 * 60_000;
/** Espera antes de la primera pasada, para no competir con el arranque. */
const RETRASO_INICIAL_MS = 10_000;
/** Un disparo oportunista no vuelve a disparar dentro de esta ventana. */
const VENTANA_OPORTUNISTA_MS = 30_000;

let temporizador: NodeJS.Timeout | null = null;
let ultimoOportunista = 0;

/**
 * Serialización DENTRO del proceso.
 *
 * El lease serializa entre réplicas; acá adentro no protege nada, porque dos
 * pasadas del mismo proceso reclaman operaciones distintas y trabajan en
 * paralelo multiplicando la carga sobre Mongo sin ganar nada. Y el arranque más
 * el barrido más un disparo oportunista pueden coincidir perfectamente.
 *
 * Se encadena en vez de descartar: quien pide una pasada recibe la promesa de
 * una que empieza DESPUÉS de la suya, así que nadie se queda sin que se mire lo
 * que acaba de encolar.
 */
let cola: Promise<ResumenReparacion | null> = Promise.resolve(null);

export function ejecutarPasadaDeReparacion(): Promise<ResumenReparacion | null> {
  cola = cola.catch(() => null).then(() => repararTransicionesPendientes());
  return cola;
}

/**
 * Arranca el ciclo. Se llama DESPUÉS de que Mongo esté conectado -- antes, cada
 * consulta se encolaría en el buffer de Mongoose y el primer barrido correría a
 * ciegas.
 */
export function iniciarReparacionDeTransiciones(): void {
  if (temporizador) return;

  setTimeout(() => {
    void pasadaDeMantenimiento('arranque');
  }, RETRASO_INICIAL_MS);

  temporizador = setInterval(() => { void pasadaDeMantenimiento('barrido'); }, INTERVALO_MS);
  // No sostiene el proceso vivo solo por este timer.
  temporizador.unref?.();
}

export function detenerReparacionDeTransiciones(): void {
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
}

/**
 * Disparo oportunista: se acaba de detectar una transición que quedó pendiente,
 * así que conviene mirar la cola ya.
 *
 * Fire-and-forget A PROPÓSITO: nunca puede demorar la respuesta HTTP que lo
 * originó. Y con ventana, para que una ráfaga de operaciones no dispare una
 * pasada por cada una.
 */
export function dispararReparacionOportunista(): void {
  const ahora = Date.now();
  if (ahora - ultimoOportunista < VENTANA_OPORTUNISTA_MS) return;
  ultimoOportunista = ahora;
  void pasadaDeMantenimiento('oportunista');
}

/** No repetir el mismo aviso de cola enferma más seguido que esto. */
const VENTANA_AVISO_MS = 15 * 60_000;
let ultimoAviso = 0;

/**
 * Mide la cola y avisa si está enferma. Se llama SIEMPRE, haya habido trabajo o
 * no.
 *
 * Esto último es el punto. Antes se volvía apenas la pasada revisaba cero, y
 * ese es exactamente el estado de una cola enferma: una `failed` no la toma
 * nadie nunca, y una pendiente esperando su backoff tampoco, así que todos los
 * barridos dan cero -- y la cola desaparecía de la vista justo cuando había algo
 * para ver.
 *
 * Medir es barato (tres consultas contadas); lo que hay que limitar es el log,
 * o un problema que dura una tarde llena el archivo con la misma línea.
 */
let ultima: Awaited<ReturnType<typeof metricasDeReparacion>> | null = null;

/** La última medición de la cola. Es lo que expone el estado a quien lo mire. */
export function ultimaObservacion() { return ultima; }

export async function observarCola(origen: string) {
  const m = await metricasDeReparacion();
  ultima = m;
  const enferma = m.fallidas > 0 || m.edadMaximaMs > 60 * 60_000;
  if (enferma && Date.now() - ultimoAviso >= VENTANA_AVISO_MS) {
    ultimoAviso = Date.now();
    console.warn(
      `[transition-repair] cola (${origen}): ${m.pendientes} pendiente(s), ` +
      `${m.fallidas} fallida(s), la más vieja lleva ${Math.round(m.edadMaximaMs / 60_000)} min`,
    );
  }
  return m;
}

/**
 * Una pasada COMPLETA: repara y después mide, en ese orden y siempre.
 *
 * Exportada porque es el camino real -- el que corren el arranque, el barrido y
 * el disparo oportunista. Un caso que llame a `observarCola` por su cuenta
 * prueba que la medición funciona, no que alguien la esté llamando.
 */
export async function pasadaDeMantenimiento(origen: string): Promise<void> {
  try {
    const resumen = await ejecutarPasadaDeReparacion();
    if (resumen && resumen.revisadas > 0) {
      console.log(
        `[transition-repair] ${origen}: ${resumen.revisadas} revisada(s), ` +
        `${resumen.reanudadas} reanudada(s), ${resumen.superadas} superada(s), ` +
        `${resumen.fallidas} fallida(s), ${resumen.pospuestas} pospuesta(s)`,
      );
    }
    await observarCola(origen);
  } catch (err: any) {
    console.warn(`[transition-repair] pasada (${origen}) falló:`, err?.message);
  }
}
