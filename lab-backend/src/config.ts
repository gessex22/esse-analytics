import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Gate explícito: este módulo se importa ANTES que nada más en server.ts, y
// server.ts aborta el arranque si esto es false. Es la única forma de que el
// Laboratorio quede activo -- no hay flag de UI ni default "on" en ningún lado.
export const LAB_MODE = process.env.ESSENALYTICS_LAB_MODE === '1';

export const PORT = Number(process.env.PORT) || 5055;

// Store JSON aislado -- nunca esse_local.db (SQLite de local-backend) ni Mongo
// de backend/. Default relativo al propio paquete, no al userData de ninguna
// instalación real.
export const DATA_DIR = process.env.LAB_DATA_DIR
  ? path.resolve(process.env.LAB_DATA_DIR)
  : path.join(__dirname, '..', 'lab-data');
export const DB_PATH = path.join(DATA_DIR, 'lab.json');

// Secreto de JWT deliberadamente distinto del de backend/local-backend (ver
// .env.example) -- un token de Laboratorio nunca debe validar contra la
// central real, ni viceversa.
export const JWT_SECRET = process.env.LAB_JWT_SECRET || 'esse_lab_secret_never_use_in_prod';

export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
