import { db } from './database';

// Ver docs/bug-reports.md BUG-2026-08-15-07 -- reportUploadEvent
// (upload-history.service.ts) mandaba el evento de historial a la central
// como "best-effort" puro: si fallaba (red, token vencido, 500), un
// console.warn y se perdía para siempre. Esta tabla lo vuelve durable: el
// evento se encola ACÁ primero, y solo se marca 'delivered' con una
// respuesta 2xx real de la central -- history-outbox.service.ts reintenta
// lo que quede 'pending' en cada push (mismo punto que ya dispara
// pushFilesToCloudInBackground) y al arrancar el server.
export type HistoryOutboxStatus = 'pending' | 'delivered' | 'failed';

export interface HistoryOutboxEntry {
  id: number;
  platform: string;
  platform_id: string;
  platform_url: string | null;
  file_name: string | null;
  content_id: string | null;
  title: string | null;
  published_at: string | null;
  source: string | null;
  device_id: string | null;
  device_name: string | null;
  status: HistoryOutboxStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export const historyOutboxRepo = {
  enqueue(data: {
    platform: string;
    platform_id: string;
    platform_url?: string | null;
    file_name?: string | null;
    content_id?: string | null;
    title?: string | null;
    published_at?: string | null;
    source?: string | null;
    device_id?: string | null;
    device_name?: string | null;
  }): number {
    const result = db.prepare(`
      INSERT INTO history_outbox (platform, platform_id, platform_url, file_name, content_id, title, published_at, source, device_id, device_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.platform, data.platform_id, data.platform_url ?? null,
      data.file_name ?? null, data.content_id ?? null, data.title ?? null,
      data.published_at ?? null, data.source ?? null,
      data.device_id ?? null, data.device_name ?? null,
    );
    return Number(result.lastInsertRowid);
  },

  findPending(limit = 50): HistoryOutboxEntry[] {
    return db.prepare(`
      SELECT * FROM history_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?
    `).all(limit) as HistoryOutboxEntry[];
  },

  countPending(): number {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM history_outbox WHERE status = 'pending'`).get() as { c: number };
    return row.c;
  },

  markDelivered(id: number): void {
    db.prepare(`
      UPDATE history_outbox SET status = 'delivered', updated_at = datetime('now'), delivered_at = datetime('now')
      WHERE id = ?
    `).run(id);
  },

  // Se queda en 'pending' (no 'failed') -- un fallo de red/token vencido es
  // transitorio, tiene que seguir reintentándose solo. 'failed' queda
  // reservado para cuando la central responde con un error que NUNCA va a
  // cambiar reintentando (ver markPermanentlyFailed).
  markRetry(id: number, error: string): void {
    db.prepare(`
      UPDATE history_outbox SET attempts = attempts + 1, last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(error.slice(0, 500), id);
  },

  markPermanentlyFailed(id: number, error: string): void {
    db.prepare(`
      UPDATE history_outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(error.slice(0, 500), id);
  },
};
