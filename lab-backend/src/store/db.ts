import fs from 'fs';
import path from 'path';
import { DATA_DIR, DB_PATH } from '../config';
import { LabDb, emptyDb } from './types';

// Persistencia mínima: todo el store en un único JSON, reescrito completo en
// cada mutación. Nada de esto necesita ser rápido ni concurrente-seguro de
// verdad -- es un servidor de laboratorio para un puñado de dispositivos de
// prueba, no producción. La ventaja sobre SQLite/Mongo es justamente esta:
// "resetear el Laboratorio" es borrar un archivo, y no hay ningún driver real
// de base de datos que pueda confundirse con el de una instalación real.
let db: LabDb;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadDb(): LabDb {
  ensureDataDir();
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = fs.readFileSync(DB_PATH, 'utf-8');
      db = { ...emptyDb(), ...JSON.parse(raw) };
      return db;
    } catch (err) {
      console.warn(`[lab-backend] lab.json corrupto o ilegible, se reinicia vacío: ${(err as Error).message}`);
    }
  }
  db = emptyDb();
  persist();
  return db;
}

export function getDb(): LabDb {
  if (!db) return loadDb();
  return db;
}

export function persist(): void {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

// Vacía todo el store y lo vuelve a persistir -- usado por POST /api/lab/reset.
export function resetDb(): LabDb {
  db = emptyDb();
  persist();
  return db;
}

export function dbPath(): string {
  return path.resolve(DB_PATH);
}
