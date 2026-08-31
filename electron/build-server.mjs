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
    // Son solo un path a un binario (ffmpeg.exe/ffprobe.exe) — si se bundlean, el
    // __dirname que usan para ubicar el binario queda apuntando a dist/ en vez de a
    // su propia carpeta en node_modules, y el binario nunca se copia ahí.
    'ffmpeg-static',
    'ffprobe-static',
  ],
  // Suprime warnings de módulos de Node built-in
  logLevel: 'info',
});

console.log(`✓ server.cjs generado en ${outFile}`);

// La pantalla de "puerto ocupado" es HTML plano, no pasa por tsc (que solo
// compila .ts). Se copia acá para que exista tanto en `npm run dev` como en el
// instalador (electron-builder empaqueta dist/** completo). Sin esto, el
// main process llamaría a loadFile() sobre un archivo inexistente justo en el
// unico momento en que no hay ninguna otra ventana que mostrar.
const portConflictSrc = path.join(__dirname, 'src/port-conflict.html');
const portConflictOut = path.join(__dirname, 'dist/port-conflict.html');
fs.copyFileSync(portConflictSrc, portConflictOut);
console.log(`✓ port-conflict.html copiado a ${portConflictOut}`);

// Mismo motivo: la pantalla muestra el logo de la app y los assets de
// electron-builder (buildResources) no se copian al paquete final.
fs.copyFileSync(path.join(__dirname, 'assets/icon.png'), path.join(__dirname, 'dist/icon.png'));
console.log('✓ icon.png copiado a dist/');
