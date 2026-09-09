import { getOrCreateDeviceName } from '../routes/local-admin.routes';
import { deviceIdentityRepo } from '../db/device-identity.repo';
import { historyOutboxRepo } from '../db/history-outbox.repo';
import { transitionOutboxRepo, TransitionOutboxEntry } from '../db/transition-outbox.repo';
import { platformRevisionRepo } from '../db/platform-revision.repo';
import { flushTransitionOutbox } from './transition-outbox.service';
import { CENTRAL_API } from '../config';

const CENTRAL = CENTRAL_API;

// Reporta a la central UN evento de subida confirmada, en el momento exacto en que
// pasa -- para que Historial (local y remoto/Android) tenga el registro real sin
// depender del push completo del catálogo (que puede tardar, fallar, o quedar
// flaco tras un wipe de logout).
//
// FIX 2026-08-15 (ver docs/bug-reports.md BUG-2026-08-15-07): antes esto era
// "best-effort" puro -- si el POST fallaba (red, token vencido, 500), un
// console.warn y el evento se perdía PARA SIEMPRE. La subida a la plataforma
// ya se había completado, así que Electron seguía mostrándola bien (lee su
// propia SQLite) mientras web/iOS/Android (que dependen de
// UploadHistoryModel en la central) nunca se enteraban -- sin ningún error
// visible, sin reintento, sin registro de que algo había quedado pendiente.
// Ahora el evento se encola en `history_outbox` (SQLite local, durable)
// ANTES de intentar entregarlo -- si la entrega inmediata falla, sigue
// 'pending' ahí y se reintenta en el próximo flushHistoryOutbox (dispara en
// cada pushFilesToCloudInBackground y al arrancar el server). Nunca rompe
// la subida en sí: encolar es síncrono y local, no depende de la central.
export async function reportUploadEvent(
  authHeader: string | undefined,
  data: {
    platform: string;
    source?: string;
    platformId: string;
    platformUrl?: string | null;
    fileName?: string | null;
    contentId?: string | null;
    title?: string | null;
    publishedAt?: string | Date;
  },
): Promise<void> {
  // FIX 2026-08-14: usaba configRepo.get('install_id') -- el secreto de auth
  // que se borra en cada logout, no la identidad estable de la PC (ver
  // docs/primary-install-corrected-plan-2026-08-14.md). Un video publicado
  // justo después de un logout/login quedaba con el device de Historial
  // desalineado, y si install_id todavía no se había regenerado (null), el
  // evento ni se reportaba (el `if (!deviceId) return` de abajo). deviceId
  // vía deviceIdentityRepo siempre existe (getOrCreate lo crea si falta).
  const deviceId = deviceIdentityRepo.getOrCreate();
  const deviceName = getOrCreateDeviceName();
  const publishedAt = data.publishedAt ? new Date(data.publishedAt).toISOString() : new Date().toISOString();

  const outboxId = historyOutboxRepo.enqueue({
    platform: data.platform, platform_id: data.platformId,
    platform_url: data.platformUrl, file_name: data.fileName,
    content_id: data.contentId, title: data.title,
    published_at: publishedAt, source: data.source ?? 'pc',
    device_id: deviceId, device_name: deviceName,
  });

  if (!authHeader) return; // queda 'pending' -- el próximo flush con sesión activa lo reintenta

  try {
    const res = await fetch(`${CENTRAL}/api/sync/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({
        deviceId, deviceName,
        source:      data.source ?? 'pc',
        platform:    data.platform,
        platformId:  data.platformId,
        platformUrl: data.platformUrl ?? null,
        fileName:    data.fileName ?? null,
        contentId:   data.contentId ?? null,
        title:       data.title ?? null,
        publishedAt,
      }),
    });
    if (res.ok) {
      historyOutboxRepo.markDelivered(outboxId);
    } else {
      console.warn(`[history] central respondió HTTP ${res.status} -- queda pendiente, se reintenta solo`);
      historyOutboxRepo.markRetry(outboxId, `HTTP ${res.status}`);
    }
  } catch (err: any) {
    // La plataforma ya pudo haber publicado. No convertir una falla de
    // propagación en un falso error de subida -- pero a diferencia de antes,
    // esto YA NO se pierde: queda 'pending' en el outbox.
    console.warn('[history] no se pudo propagar el evento (queda pendiente):', err.message);
    historyOutboxRepo.markRetry(outboxId, err.message ?? 'error de red');
  }
}

/**
 * Avisa a la central que se soltó una plataforma.
 *
 * Entrega 1.3/1.4 de docs/sync-convergence-plan-2026-09-08.md. Dos cambios:
 *
 * 1. Se manda `contentId` (UUID compartido por los dos lados), no el id de
 *    SQLite. Antes se mandaba el entero local y la central lo usaba como filtro
 *    `_id` de Mongo -> CastError -> 500. El unlink nunca llegó, ni una vez.
 * 2. Ya NO se traga el error. Antes cualquier fallo terminaba en un
 *    `console.warn` que nadie mira, y el usuario veía el link desaparecer de su
 *    pantalla creyendo que se había guardado. Ahora se lanza, y el caller decide
 *    qué mostrar.
 *
 * Lo que NO cambia: sigue siendo una llamada best-effort respecto del estado
 * local -- para cuando se llama, la SQLite ya se actualizó. Lanzar acá sirve
 * para AVISAR, no para revertir.
 */
/**
 * Encola la intención de desvincular. SÍNCRONO a propósito.
 *
 * Está separado de la entrega justamente para poder correr DENTRO de la misma
 * `db.transaction()` que suelta el vínculo y saca el badge (ver
 * `setPlatformLink`). Mientras el encolado vivía después de esas dos
 * escrituras, una caída en el medio dejaba exactamente el estado que la outbox
 * venía a eliminar: lo local cambiado, la central sin enterarse y nada
 * encolado que lo reintente. La outbox no vale por guardar la intención, sino
 * por guardarla en la misma transacción que el cambio que la origina.
 *
 * `better-sqlite3` exige que el cuerpo de una transacción sea síncrono, así que
 * acá no puede haber ningún `await`: la entrega va después del commit.
 */
export function encolarDesvinculacion(
  contentId: string | null | undefined,
  platform: string,
): TransitionOutboxEntry {
  if (!contentId) {
    throw new Error(
      `No se puede propagar la desvinculación de ${platform}: el archivo no tiene content_id. ` +
      `Sin él la central no puede identificarlo (el id local no le sirve).`,
    );
  }
  return transitionOutboxRepo.enqueue({
    contentId,
    platform,
    action: 'unlink',
    knownVersion: platformRevisionRepo.get(contentId, platform),
  });
}

/**
 * Intenta entregar YA una intención ya encolada, para que el caso normal (hay
 * red) siga siendo inmediato. Si falla, la fila queda 'pending' y el próximo
 * flush la toma -- por eso esto no se traga el error: el caller sigue
 * necesitando saber que la central no acompañó, aunque ahora eso ya no
 * signifique que la intención se haya perdido.
 */
export async function entregarDesvinculacion(
  authHeader: string | undefined,
  filaId: number,
  platform: string,
): Promise<void> {
  if (!authHeader) {
    throw new Error(
      `La desvinculación de ${platform} quedó pendiente: no hay sesión para entregarla. ` +
      `Se reintenta sola en la próxima sincronización.`,
    );
  }

  await flushTransitionOutbox(authHeader);

  // Se mira ESTA fila, no un contador global de pendientes: con varias
  // desvinculaciones en vuelo, "quedan pendientes" no dice nada sobre la que
  // el usuario acaba de pedir.
  const estado = transitionOutboxRepo.findById(filaId)?.status;
  if (estado === 'pending') {
    throw new Error(
      `La desvinculación de ${platform} quedó pendiente de entregar a la central. ` +
      `Se reintenta sola en la próxima sincronización.`,
    );
  }
  if (estado === 'conflict') {
    throw new Error(
      `La central rechazó la desvinculación de ${platform}: el estado de esa plataforma ` +
      `cambió desde otro dispositivo después de que abrieras esta pantalla. Actualizá y volvé a intentar.`,
    );
  }
  if (estado === 'failed') {
    throw new Error(`La central rechazó la desvinculación de ${platform}.`);
  }
}
