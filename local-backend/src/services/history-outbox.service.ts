import { historyOutboxRepo } from '../db/history-outbox.repo';
import { CENTRAL_API } from '../config';

const CENTRAL = CENTRAL_API;
let flushInProgress = false;

// Intenta entregar todo lo 'pending' a la central -- se llama desde varios
// puntos (ver reportUploadEvent, pushFilesToCloudInBackground, y al
// arrancar el server), nunca en un timer propio: reusa los mismos
// disparadores que ya existen para "algo cambió, sincronizá" en vez de sumar
// un setInterval nuevo. `flushInProgress` evita que dos llamadas
// solapadas (ej. publicar dos veces seguido) reintenten la misma fila en
// paralelo.
export async function flushHistoryOutbox(authHeader: string | undefined): Promise<{ delivered: number; stillPending: number }> {
  if (!authHeader || flushInProgress) return { delivered: 0, stillPending: historyOutboxRepo.countPending() };
  flushInProgress = true;
  let delivered = 0;
  try {
    const pending = historyOutboxRepo.findPending();
    for (const entry of pending) {
      try {
        const res = await fetch(`${CENTRAL}/api/sync/history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify({
            deviceId:    entry.device_id,
            deviceName:  entry.device_name,
            source:      entry.source ?? 'pc',
            platform:    entry.platform,
            platformId:  entry.platform_id,
            platformUrl: entry.platform_url,
            fileName:    entry.file_name,
            contentId:   entry.content_id,
            title:       entry.title,
            publishedAt: entry.published_at,
          }),
        });
        if (res.ok) {
          historyOutboxRepo.markDelivered(entry.id);
          delivered++;
        } else if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
          // 4xx que no sea auth/rate-limit (ej. 400 por payload inválido) no
          // se va a arreglar solo reintentando -- queda 'failed' para no
          // reintentar por siempre algo que la central va a rechazar
          // siempre. 401/429 SÍ quedan pending (token vencido/rate-limit son
          // transitorios).
          historyOutboxRepo.markPermanentlyFailed(entry.id, `HTTP ${res.status}`);
        } else {
          historyOutboxRepo.markRetry(entry.id, `HTTP ${res.status}`);
        }
      } catch (err: any) {
        historyOutboxRepo.markRetry(entry.id, err.message ?? 'error de red');
      }
    }
  } finally {
    flushInProgress = false;
  }
  return { delivered, stillPending: historyOutboxRepo.countPending() };
}
