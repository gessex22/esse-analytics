// Empaqueta el local-backend en un único archivo CJS para Electron.
// better-sqlite3 se marca como external porque es un módulo nativo
// que electron-builder reconstruye por su cuenta.

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localBackendEntry = path.join(__dirname, '../local-backend/src/server.ts');
const outFile = path.join(__dirname, 'dist/server.cjs');

// Asegura que dist/ exista
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });

// Secretos inyectados en build-time (no viven en el código fuente / repo).
// Se leen de electron/.env.build (gitignored) o del entorno del CI.
const buildEnv = {};
const buildEnvPath = path.join(__dirname, '.env.build');
if (fs.existsSync(buildEnvPath)) {
  for (const line of fs.readFileSync(buildEnvPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) buildEnv[m[1]] = m[2];
  }
}
const secret = (k) => buildEnv[k] ?? process.env[k] ?? '';
if (!secret('YOUTUBE_API_KEY') || !secret('CLIENT_REGISTER_KEY')) {
  console.warn('⚠ Faltan secretos de build (electron/.env.build). El bundle saldrá sin YOUTUBE_API_KEY / CLIENT_REGISTER_KEY.');
}

await build({
  entryPoints: [localBackendEntry],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: outFile,
  // Inyecta los secretos como literales en el bundle (no en el repo).
  define: {
    'process.env.YOUTUBE_API_KEY':     JSON.stringify(secret('YOUTUBE_API_KEY')),
    'process.env.CLIENT_REGISTER_KEY': JSON.stringify(secret('CLIENT_REGISTER_KEY')),
  },
  // Módulos nativos y módulos de Node que no deben ser bundleados
  external: [
    'better-sqlite3',
    'electron',
    'fsevents',
  ],
  // Suprime warnings de módulos de Node built-in
  logLevel: 'info',
});

console.log(`✓ server.cjs generado en ${outFile}`);
