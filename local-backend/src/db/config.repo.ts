import { db } from './database';

export const configRepo = {
  // ── app_config ────────────────────────────────────────────────────────────
  get(key: string): string | null {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  },

  set(key: string, value: string): void {
    db.prepare(`
      INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, value);
  },

  // ── platform_config ────────────────────────────────────────────────────────
  getPlatformConfig(platform: string): Record<string, unknown> | null {
    const row = db.prepare('SELECT * FROM platform_config WHERE platform = ?').get(platform) as Record<string, unknown> | undefined;
    return row ?? null;
  },

  getAllPlatformConfigs(): Record<string, unknown>[] {
    return db.prepare('SELECT * FROM platform_config').all() as Record<string, unknown>[];
  },

  setPlatformConfig(platform: string, fields: Partial<{
    last_published_title: string;
    last_published_date: string;
    interval_days: number;
    last_video_id: string | null;
    next_video_id: string | null;
  }>): void {
    const existing = this.getPlatformConfig(platform);

    if (!existing) {
      db.prepare(`
        INSERT INTO platform_config
          (platform, last_published_title, last_published_date, interval_days, last_video_id, next_video_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        platform,
        fields.last_published_title ?? null,
        fields.last_published_date ?? null,
        fields.interval_days ?? 4,
        fields.last_video_id ?? null,
        fields.next_video_id ?? null,
      );
    } else {
      const sets: string[] = ["updated_at = datetime('now')"];
      const params: unknown[] = [];
      const s = (col: string, v: unknown) => { sets.push(`${col} = ?`); params.push(v); };
      if (fields.last_published_title !== undefined) s('last_published_title', fields.last_published_title);
      if (fields.last_published_date  !== undefined) s('last_published_date',  fields.last_published_date);
      if (fields.interval_days        !== undefined) s('interval_days',        fields.interval_days);
      if ('last_video_id' in fields) s('last_video_id', fields.last_video_id ?? null);
      if ('next_video_id' in fields) s('next_video_id', fields.next_video_id ?? null);
      if (sets.length > 1) {
        params.push(platform);
        db.prepare(`UPDATE platform_config SET ${sets.join(', ')} WHERE platform = ?`).run(...params);
      }
    }
  },

  // ── local_config (owner) ──────────────────────────────────────────────────
  getOwner(): { username: string; linked_at: string } | null {
    const row = db.prepare("SELECT username, linked_at FROM local_config WHERE key = 'owner'")
      .get() as { username: string; linked_at: string } | undefined;
    return row ?? null;
  },

  setOwner(username: string): void {
    db.prepare(`
      INSERT INTO local_config (key, username, linked_at, updated_at)
        VALUES ('owner', ?, datetime('now'), datetime('now'))
      ON CONFLICT(key) DO UPDATE
        SET username = excluded.username, linked_at = excluded.linked_at, updated_at = datetime('now')
    `).run(username);
  },

  clearOwner(): void {
    db.prepare("DELETE FROM local_config WHERE key = 'owner'").run();
    // El secreto de instalación muere con la vinculación: al volver a vincular
    // (misma u otra cuenta) se generará uno nuevo. Evita reusarlo entre cuentas.
    db.prepare("DELETE FROM app_config WHERE key = 'install_id'").run();
  },

  // ── wipe all tables ────────────────────────────────────────────────────────
  wipeAll(): Record<string, number> {
    const results: Record<string, number> = {};
    const tables = ['publishing_status', 'platform_videos', 'files', 'platform_config', 'app_config', 'local_config'];
    for (const t of tables) {
      // Por tabla: un fallo (tabla ausente, lock, etc.) NO debe abortar el resto
      // ni impedir el clearOwner posterior (si no, no se puede cambiar de cuenta).
      try { results[t] = db.prepare(`DELETE FROM ${t}`).run().changes; }
      catch { results[t] = -1; }
    }
    return results;
  },
};
