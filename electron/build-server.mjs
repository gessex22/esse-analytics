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

await build({
  entryPoints: [localBackendEntry],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: outFile,
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
