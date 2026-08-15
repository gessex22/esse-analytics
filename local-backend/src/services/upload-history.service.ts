import { getOrCreateDeviceName } from '../routes/local-admin.routes';
import { deviceIdentityRepo } from '../db/device-identity.repo';
import { historyOutboxRepo } from '../db/history-outbox.repo';
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

export async function reportUnlinkPlatform(
  authHeader: string | undefined,
  fileId: string,
  platform: string,
): Promise<void> {
  if (!authHeader) return;
  try {
    const res = await fetch(`${CENTRAL}/api/sync/platform-link/${encodeURIComponent(fileId)}/${encodeURIComponent(platform)}`, {
      method: 'DELETE',
      headers: { Authorization: authHeader },
    });
    if (!res.ok) console.warn(`[sync] no se pudo desvincular ${platform}: HTTP ${res.status}`);
  } catch (err: any) {
    console.warn('[sync] no se pudo propagar la desvinculación:', err.message);
  }
}
