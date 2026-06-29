import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = process.env.SQLITE_DIR || path.join(os.homedir(), '.esse-analytics');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = process.env.SQLITE_PATH || path.join(DB_DIR, 'esse_local.db');

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrations
try { db.exec(`ALTER TABLE files ADD COLUMN platforms_discarded TEXT NOT NULL DEFAULT '[]'`); } catch {}
try { db.exec(`ALTER TABLE files ADD COLUMN tipo_contenido TEXT`); } catch {}
try { db.exec(`ALTER TABLE platform_videos ADD COLUMN title TEXT`); } catch {}
try { db.exec(`ALTER TABLE platform_videos ADD COLUMN description TEXT`); } catch {}

// Backfill platforms[] desde platform_videos y publishing_status (campo muerto).
// Corre solo en filas donde platforms sigue vacío ('[]').
try {
  db.exec(`
    UPDATE files
    SET platforms = (
      SELECT json_group_array(DISTINCT pv.platform)
      FROM platform_videos pv
      WHERE pv.linked_file_id = files.id
        AND pv.platform IS NOT NULL
    )
    WHERE json_array_length(platforms) = 0
      AND EXISTS (
        SELECT 1 FROM platform_videos pv
        WHERE pv.linked_file_id = files.id
      );
  `);
} catch {}

try {
  db.exec(`
    UPDATE files
    SET platforms = (
      SELECT json_group_array(p) FROM (
        SELECT DISTINCT value AS p FROM (
          SELECT value FROM json_each(files.platforms)
          UNION
          SELECT 'youtube'   WHERE (SELECT youtube_published   FROM publishing_status ps WHERE ps.file_id = files.id) = 1
          UNION
          SELECT 'instagram' WHERE (SELECT instagram_published FROM publishing_status ps WHERE ps.file_id = files.id) = 1
          UNION
          SELECT 'tiktok'    WHERE (SELECT tiktok_published    FROM publishing_status ps WHERE ps.file_id = files.id) = 1
        )
      )
    )
    WHERE EXISTS (
      SELECT 1 FROM publishing_status ps
      WHERE ps.file_id = files.id
        AND (ps.youtube_published = 1 OR ps.instagram_published = 1 OR ps.tiktok_published = 1)
    );
  `);
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
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
`);
