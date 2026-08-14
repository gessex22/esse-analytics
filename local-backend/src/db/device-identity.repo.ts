import { randomUUID } from 'crypto';
import { db } from './database';

// device_id = identidad estable de ESTA instalación física, para decidir
// primaria/secundaria (docs/primary-install-corrected-plan-2026-08-14.md).
// Vive en su propia tabla (device_identity), separada a propósito de
// install_id (config.repo/local-admin.routes, en app_config) -- son dos
// conceptos con ciclos de vida opuestos que antes compartían el mismo campo
// por error: install_id AUTORIZA operaciones destructivas y debe morir en
// cada logout; device_id IDENTIFICA la máquina física y debe sobrevivir
// logout/wipe/cambio de cuenta, solo se rota con reset() explícito.
export const deviceIdentityRepo = {
  getOrCreate(): string {
    const row = db.prepare('SELECT device_id FROM device_identity WHERE id = 1').get() as { device_id: string } | undefined;
    if (row) return row.device_id;
    const deviceId = randomUUID();
    db.prepare('INSERT INTO device_identity (id, device_id) VALUES (1, ?)').run(deviceId);
    return deviceId;
  },

  // Rotación EXPLÍCITA -- acción de soporte ("restablecer identidad de esta
  // PC"), no de uso normal. Después de esto, esta instalación vuelve a ser
  // una secundaria sin reclamar hasta que alguien la reclame de nuevo (o
  // haga el auto-claim de bootstrap si la cuenta no tenía primaria).
  reset(): string {
    const deviceId = randomUUID();
    db.prepare(`
      INSERT INTO device_identity (id, device_id) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id
    `).run(deviceId);
    return deviceId;
  },
};
