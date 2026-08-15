import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { LAB_MODE } from '../config';

const DB_DIR = process.env.SQLITE_DIR || path.join(os.homedir(), '.esse-analytics');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// En modo Laboratorio el nombre de archivo cambia SIEMPRE, aunque alguien se
// olvide de pasar un SQLITE_DIR/SQLITE_PATH distinto -- así es estructuralmente
// imposible que el Laboratorio termine leyendo/escribiendo esse_local.db real.
const DB_PATH = process.env.SQLITE_PATH || path.join(DB_DIR, LAB_MODE ? 'esse_lab.db' : 'esse_local.db');

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Esquema — va ANTES de las migraciones/backfills de abajo: en una instalación
// nueva (sin esse_local.db previo) esas migraciones necesitan que las tablas ya
// existan, si no fallan con "no such table" hasta el próximo reinicio.
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id        TEXT,
    file_name         TEXT    NOT NULL,
    file_path         TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'PENDIENTE',
    content_status    TEXT    NOT NULL DEFAULT 'borrador',
    platforms         TEXT    NOT NULL DEFAULT '[]',
    duracion_segundos REAL,
    resolucion        TEXT,
    formato           TEXT,
    fecha_creacion    TEXT,
    scheduled_date    TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS publishing_status (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id             INTEGER NOT NULL UNIQUE REFERENCES files(id),
    title               TEXT    NOT NULL,
    tiktok_published    INTEGER NOT NULL DEFAULT 0,
    instagram_published INTEGER NOT NULL DEFAULT 0,
    youtube_published   INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS platform_videos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    platform        TEXT    NOT NULL,
    platform_id     TEXT    NOT NULL,
    platform_url    TEXT,
    published_at    TEXT,
    linked_file_id  INTEGER REFERENCES files(id),
    match_status    TEXT    NOT NULL DEFAULT 'sin_match',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_videos_platform_id
    ON platform_videos(platform, platform_id);


  CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS platform_config (
    platform              TEXT PRIMARY KEY,
    last_published_title  TEXT,
    last_published_date   TEXT,
    interval_days         INTEGER DEFAULT 4,
    last_video_id         TEXT,
    next_video_id         TEXT,
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS local_config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    username   TEXT,
    linked_at  TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transcripts (
    file_id    INTEGER PRIMARY KEY REFERENCES files(id),
    text       TEXT    NOT NULL,
    language   TEXT    NOT NULL DEFAULT 'es',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ideas_centrales (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_nucleo        TEXT    NOT NULL,
    resumen_visual     TEXT    NOT NULL,
    status             TEXT    NOT NULL DEFAULT 'borrador',
    video_principal_id INTEGER REFERENCES files(id),
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS idea_videos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id         INTEGER NOT NULL REFERENCES ideas_centrales(id) ON DELETE CASCADE,
    file_id         INTEGER NOT NULL REFERENCES files(id),
    similitud_guion REAL    NOT NULL DEFAULT 100.0,
    rol             TEXT    NOT NULL DEFAULT 'RELACIONADO',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(idea_id, file_id)
  );

  -- Identidad estable de ESTA instalación física, separada a propósito de
  -- app_config (donde vive install_id) -- ver
  -- docs/primary-install-corrected-plan-2026-08-14.md. wipeAll()/clearOwner()
  -- no mencionan esta tabla, así que sobrevive logout/wipe/cambio de cuenta.
  -- Solo se rota con una acción explícita de soporte ("restablecer identidad
  -- de esta PC"), nunca automáticamente.
  CREATE TABLE IF NOT EXISTS device_identity (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL
  );

  -- Outbox de eventos de historial pendientes de confirmar en la central --
  -- ver docs/bug-reports.md BUG-2026-08-15-07. reportUploadEvent (upload-
  -- history.service.ts) encolaba el POST a /api/sync/history como
  -- "best-effort": si fallaba (red, token vencido, 500), solo hacía
  -- console.warn y se perdía para siempre -- la subida seguía OK localmente
  -- (Electron leía su propia SQLite) pero web/iOS/Android, que dependen de
  -- UploadHistoryModel en la central, nunca se enteraban. Ahora el evento se
  -- encola ACÁ primero (durable) antes de intentar entregarlo -- solo se
  -- marca 'delivered' con una respuesta 2xx real de la central.
  CREATE TABLE IF NOT EXISTS history_outbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    platform     TEXT    NOT NULL,
    platform_id  TEXT    NOT NULL,
    platform_url TEXT,
    file_name    TEXT,
    content_id   TEXT,
    title        TEXT,
    published_at TEXT,
    source       TEXT,
    device_id    TEXT,
    device_name  TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending', -- pending | delivered | failed
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  );
`);

// Migrations
try { db.exec(`ALTER TABLE files ADD COLUMN platforms_discarded TEXT NOT NULL DEFAULT '[]'`); } catch {}
try { db.exec(`ALTER TABLE files ADD COLUMN tipo_contenido TEXT`); } catch {}
try { db.exec(`ALTER TABLE files ADD COLUMN content_id TEXT`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_files_content_id ON files(content_id) WHERE content_id IS NOT NULL`); } catch {}
try { db.exec(`ALTER TABLE platform_videos ADD COLUMN title TEXT`); } catch {}
try { db.exec(`ALTER TABLE platform_videos ADD COLUMN description TEXT`); } catch {}

// Backfill content_id para filas creadas antes de este campo (SQLite no genera UUIDs nativos).
try {
  const rowsSinContentId = db.prepare(`SELECT id FROM files WHERE content_id IS NULL`).all() as { id: number }[];
  if (rowsSinContentId.length > 0) {
    const setContentId = db.prepare(`UPDATE files SET content_id = ? WHERE id = ?`);
    const backfill = db.transaction((rows: { id: number }[]) => {
      for (const row of rows) setContentId.run(randomUUID(), row.id);
    });
    backfill(rowsSinContentId);
  }
} catch (e) { console.warn('Backfill content_id falló:', e); }

// Trazabilidad de publicación: migración tolerante para instalaciones existentes.
for (const column of ['device_id', 'source']) {
  try { db.exec(`ALTER TABLE platform_videos ADD COLUMN ${column} TEXT`); } catch { /* ya existe */ }
}

// Backfill platforms[] desde platform_videos (DISTINCT via subquery — SQLite no soporta json_group_array(DISTINCT)).
try {
  db.exec(`
    UPDATE files
    SET platforms = (
      SELECT json_group_array(p) FROM (
        SELECT DISTINCT pv.platform AS p
        FROM platform_videos pv
        WHERE pv.linked_file_id = files.id
          AND pv.platform IS NOT NULL
      )
    )
    WHERE json_array_length(platforms) = 0
      AND EXISTS (
        SELECT 1 FROM platform_videos pv WHERE pv.linked_file_id = files.id
      );
  `);
} catch (e) { console.warn('Backfill platform_videos→files.platforms falló:', e); }

// Backfill desde publishing_status (campo legado: youtube_published, instagram_published, tiktok_published).
try {
  db.exec(`
    UPDATE files
    SET platforms = (
      SELECT json_group_array(p) FROM (
        SELECT 'youtube'   AS p WHERE (SELECT youtube_published   FROM publishing_status ps WHERE ps.file_id = files.id LIMIT 1) = 1
        UNION ALL
        SELECT 'instagram' AS p WHERE (SELECT instagram_published FROM publishing_status ps WHERE ps.file_id = files.id LIMIT 1) = 1
        UNION ALL
        SELECT 'tiktok'    AS p WHERE (SELECT tiktok_published    FROM publishing_status ps WHERE ps.file_id = files.id LIMIT 1) = 1
      )
    )
    WHERE json_array_length(platforms) = 0
      AND EXISTS (
        SELECT 1 FROM publishing_status ps
        WHERE ps.file_id = files.id
          AND (ps.youtube_published = 1 OR ps.instagram_published = 1 OR ps.tiktok_published = 1)
      );
  `);
} catch (e) { console.warn('Backfill publishing_status→files.platforms falló:', e); }
