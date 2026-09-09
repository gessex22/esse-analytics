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
    void pasadaConReporte('arranque');
  }, RETRASO_INICIAL_MS);

  temporizador = setInterval(() => { void pasadaConReporte('barrido'); }, INTERVALO_MS);
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
  void pasadaConReporte('oportunista');
}

async function pasadaConReporte(origen: string): Promise<void> {
  try {
    const resumen = await ejecutarPasadaDeReparacion();
    if (!resumen || resumen.revisadas === 0) return;
    console.log(
      `[transition-repair] ${origen}: ${resumen.revisadas} revisada(s), ` +
      `${resumen.reanudadas} reanudada(s), ${resumen.superadas} superada(s), ` +
      `${resumen.fallidas} fallida(s), ${resumen.pospuestas} pospuesta(s)`,
    );

    // La cola solo se puede operar si se la mide. `pendientes` sube y baja
    // sola; lo que hay que mirar es `fallidas` (nadie las reintenta) y la EDAD
    // de la más vieja, que es lo que distingue "hay cola" de "hay cola
    // TRABADA".
    const m = await metricasDeReparacion();
    if (m.fallidas > 0 || m.edadMaximaMs > 60 * 60_000) {
      console.warn(
        `[transition-repair] cola: ${m.pendientes} pendiente(s), ${m.fallidas} fallida(s), ` +
        `la más vieja lleva ${Math.round(m.edadMaximaMs / 60_000)} min`,
      );
    }
  } catch (err: any) {
    console.warn(`[transition-repair] pasada (${origen}) falló:`, err?.message);
  }
}
