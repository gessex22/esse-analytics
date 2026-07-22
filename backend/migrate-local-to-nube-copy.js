#!/usr/bin/env node
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

require('dotenv').config();

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

const VIDEO_EXT_WHITELIST = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.3gp']);

function getRemoteLibraryDir() {
  const dir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function requireBetterSqlite3() {
  try {
    return require('better-sqlite3');
  } catch {
    const fallback = path.join(__dirname, '..', 'local-backend', 'node_modules', 'better-sqlite3');
    return require(fallback);
  }
}

async function main() {
  const dbPath = process.env.SQLITE_PATH || path.join(os.homedir(), '.esse-analytics', 'esse_local.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No encontré la base local en ${dbPath}. Si tu instalación usa otra ruta, corré con SQLITE_PATH=<ruta> node migrate-local-to-nube-copy.js`);
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('No encontré MONGO_URI -- corré este script desde la carpeta backend/ (con su .env), no desde local-backend/.');
    process.exit(1);
  }

  const Database = requireBetterSqlite3();
  const mongoose = require('mongoose');

  const username = (await prompt('Usuario dueño de los videos: ')).trim().toLowerCase();

  console.log('Conectando a MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);

  const UserModel = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');
  const RemoteLibraryVideoModel = mongoose.model(
    'RemoteLibraryVideo',
    new mongoose.Schema({
      userId: String, fileName: String, storedFileName: String, sizeBytes: Number,
      durationSeconds: Number, resolution: String, formato: String,
      thumbnailStoredFileName: String, platforms: [String], platformsDiscarded: [String],
    }, { timestamps: true }),
    'remote_library_videos',
  );

  const user = await UserModel.findOne({ username });
  if (!user) {
    console.error(`No existe el usuario "${username}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const userId = user._id.toString();

  const existing = await RemoteLibraryVideoModel.find({ userId }).select('fileName').lean();
  const alreadyInCloud = new Set(existing.map(v => v.fileName));

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    SELECT file_name, file_path, duracion_segundos, resolucion, formato
    FROM files
    WHERE status != 'ELIMINADO_DISCO'
  `).all();
  db.close();

  const pending = rows.filter(r => !alreadyInCloud.has(r.file_name) && fs.existsSync(r.file_path));
  const skippedMissing = rows.filter(r => !alreadyInCloud.has(r.file_name) && !fs.existsSync(r.file_path));
  const skippedAlready = rows.length - pending.length - skippedMissing.length;

  console.log(`${rows.length} en la biblioteca local — ${pending.length} para migrar, ${skippedAlready} ya estaban en Nube, ${skippedMissing.length} sin archivo en disco (se saltean).`);

  const userDir = path.join(getRemoteLibraryDir(), userId);
  fs.mkdirSync(userDir, { recursive: true });

  let ok = 0, failed = 0;
  for (const [i, row] of pending.entries()) {
    process.stdout.write(`[${i + 1}/${pending.length}] ${row.file_name} ... `);
    try {
      const ext = VIDEO_EXT_WHITELIST.has(path.extname(row.file_path).toLowerCase())
        ? path.extname(row.file_path).toLowerCase()
        : '.mp4';
      const storedFileName = `${crypto.randomUUID()}${ext}`;
      const destPath = path.join(userDir, storedFileName);

      // Hard link, no copia -- misma data en disco, dos entradas de directorio.
      // Cero espacio extra, instantáneo. Funciona porque origen y destino están
      // en el mismo volumen (C:); si no lo estuvieran fs.linkSync tira EXDEV,
      // que cae en el catch de abajo como cualquier otro error por archivo.
      fs.linkSync(row.file_path, destPath);
      const sizeBytes = fs.statSync(destPath).size;

      await RemoteLibraryVideoModel.create({
        userId,
        fileName: row.file_name,
        storedFileName,
        sizeBytes,
        durationSeconds: row.duracion_segundos ?? undefined,
        resolution: row.resolucion ?? undefined,
        formato: row.formato ?? undefined,
        platforms: [],
        platformsDiscarded: [],
      });

      console.log('OK');
      ok++;
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nListo. ${ok} migrados, ${failed} con error.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
