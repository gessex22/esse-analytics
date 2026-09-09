import { randomUUID } from 'crypto';
import { db } from './database';

// Outbox de TRANSICIONES de plataforma (desvincular / descartar).
//
// POR QUÉ EXISTE. `reportUnlinkPlatform` hacía el DELETE contra la central y,
// si fallaba, lanzaba; `setPlatformLink` lo atrapaba y devolvía un
// `syncWarning` en el JSON. Ahí terminaba todo: la SQLite local ya estaba
// desvinculada, la central nunca se enteró, y no quedaba nada que reintentar
// -- ni en ese momento ni nunca. El usuario veía el link desaparecer de su
// pantalla y en el próximo pull podía volver, porque del otro lado no había
// pasado nada. Es el mismo agujero que ya se había tapado para el historial
// (BUG-2026-08-15-07), en otra ruta.
//
// Es una cola, no un log: el orden importa. Dos transiciones sobre la MISMA
// (content_id, plataforma) se decidieron una sobre el resultado de la otra,
// así que entregar la segunda antes que la primera la haría llegar con una
// base que todavía no existe.
export type TransitionOutboxStatus = 'pending' | 'delivered' | 'conflict' | 'failed';

export interface TransitionOutboxEntry {
  id: number;
  /** Identidad de la operación para la central: es lo que permite deduplicar. */
  operation_id: string;
  content_id: string;
  platform: string;
  action: string;
  /** La revisión que el cliente VIO al decidir. Nunca se recalcula. */
  base_version: number;
  status: TransitionOutboxStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export const transitionOutboxRepo = {
  /**
   * Encola una transición y devuelve la fila.
   *
   * `base_version` sale de la última revisión conocida para esa
   * (content_id, plataforma) -- salvo que ya haya una transición encolada sin
   * entregar sobre la misma clave: en ese caso esta decisión se tomó SOBRE EL
   * RESULTADO de aquella, y su base es la revisión que aquella va a producir
   * (la central incrementa de a uno por transición aplicada). Si se usara la
   * revisión "actual" para las dos, la segunda llegaría declarando una base
   * que ya no describe el estado sobre el que se decidió.
   */
  enqueue(data: {
    contentId: string;
    platform: string;
    action: string;
    knownVersion: number;
  }): TransitionOutboxEntry {
    const previa = db.prepare(`
      SELECT base_version FROM transition_outbox
      WHERE content_id = ? AND platform = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 1
    `).get(data.contentId, data.platform) as { base_version: number } | undefined;

    const baseVersion = previa ? previa.base_version + 1 : data.knownVersion;

    const result = db.prepare(`
      INSERT INTO transition_outbox (operation_id, content_id, platform, action, base_version)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), data.contentId, data.platform, data.action, baseVersion);

    return db.prepare('SELECT * FROM transition_outbox WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as TransitionOutboxEntry;
  },

  findById(id: number): TransitionOutboxEntry | undefined {
    return db.prepare('SELECT * FROM transition_outbox WHERE id = ?')
      .get(id) as TransitionOutboxEntry | undefined;
  },

  findPending(limit = 100): TransitionOutboxEntry[] {
    return db.prepare(`
      SELECT * FROM transition_outbox WHERE status = 'pending' ORDER BY id ASC LIMIT ?
    `).all(limit) as TransitionOutboxEntry[];
  },

  countPending(): number {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM transition_outbox WHERE status = 'pending'`).get() as { c: number };
    return row.c;
  },

  markDelivered(id: number): void {
    db.prepare(`
      UPDATE transition_outbox
      SET status = 'delivered', attempts = attempts + 1,
          updated_at = datetime('now'), delivered_at = datetime('now')
      WHERE id = ?
    `).run(id);
  },

  /** Sigue 'pending': red caída, token vencido y 5xx son transitorios. */
  markRetry(id: number, error: string): void {
    db.prepare(`
      UPDATE transition_outbox SET attempts = attempts + 1, last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(error.slice(0, 500), id);
  },

  /**
   * Se archiva sin entregar. Dos motivos, los dos definitivos:
   *
   *  - 'conflict' (409): la operación llegó tarde, el estado cambió después.
   *    Reintentarla no la va a rejuvenecer, y re-basarla sobre el estado nuevo
   *    sería aplicar una decisión vieja a un estado que el usuario no vio.
   *  - 'failed' (4xx): la central la rechaza y va a seguir rechazándola.
   *
   * En los dos casos lo que NO se puede hacer es dejarla pendiente: una fila
   * que se reintenta para siempre es una cola que nunca se vacía.
   */
  markResolved(id: number, status: 'conflict' | 'failed', error: string): void {
    db.prepare(`
      UPDATE transition_outbox SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, error.slice(0, 500), id);
  },
};
