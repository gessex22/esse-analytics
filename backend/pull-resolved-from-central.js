#!/usr/bin/env node
// El botón "Traer" de Gemas (POST /api/local/backup/pull) usa GET /api/backup/files,
// que a propósito OCULTA los videos ya resueltos en las 3 plataformas (mismo filtro
// que la vista principal de Videos). Resultado: de 1112 videos, 1061 ya estaban
// resueltos y por eso nunca llegaron al pull -- solo se actualizaron los ~51 que
// seguían pendientes. Este script escribe directo en la SQLite LOCAL usando la
// colección central "files" sin ese filtro, así se recupera también lo ya resuelto.
// Aditivo/protegido: nunca pisa un archivo local que YA tenga platforms/discarded.
//
// Corré esto en la PC de Windows, desde la carpeta `backend` (igual que los
// scripts anteriores). Necesita que ya hayas dejado que la app reescanee tu
// carpeta de videos (para que la tabla files local tenga una fila por archivo).

const path = require('path');
const os = require('os');
const fs = require('fs');
const readline = require('readline');

require('dotenv').config();

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function requireFromLocalBackend(pkg) {
  try {
    return require(pkg);
  } catch {
    return require(path.join(__dirname, '..', 'local-backend', 'node_modules', pkg));
  }
}

async function main() {
  const dbPath = process.env.SQLITE_PATH || path.join(os.homedir(), '.esse-analytics', 'esse_local.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No encontré la base local en ${dbPath}.`);
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('No encontré MONGO_URI -- corré esto desde la carpeta backend/.');
    process.exit(1);
  }

  const Database = requireFromLocalBackend('better-sqlite3');
  const mongoose = require('mongoose');

  const username = (await prompt('Usuario dueño de los videos: ')).trim().toLowerCase();

  console.log('Conectando a MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);

  const UserModel = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');
  const CentralFileModel = mongoose.model('CentralFile', new mongoose.Schema({}, { strict: false }), 'files');

  const user = await UserModel.findOne({ username });
  if (!user) {
    console.error(`No existe el usuario "${username}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const userId = user._id.toString();

  const centralFiles = await CentralFileModel.find({ userId }).select('file_name platforms platforms_discarded').lean();
  const byFileName = new Map(centralFiles.map(f => [f.file_name, f]));
  console.log(`${centralFiles.length} archivos en la colección central "files" (sin el filtro que oculta lo resuelto).`);
  await mongoose.disconnect();

  const db = new Database(dbPath);
  const rows = db.prepare(`SELECT id, file_name, platforms, platforms_discarded FROM files`).all();
  console.log(`${rows.length} archivos en la SQLite local para revisar.`);

  // updated_at con datetime('now') -- mismo formato que usa file.repo.ts en el
  // resto de la app (TEXT "YYYY-MM-DD HH:MM:SS"), no ISO 8601.
  const update = db.prepare(`UPDATE files SET platforms = ?, platforms_discarded = ?, updated_at = datetime('now') WHERE id = ?`);

  let fixed = 0, skippedHadData = 0, skippedNoMatch = 0;

  const txn = db.transaction(rows => {
    for (const row of rows) {
      let currentPlatforms = [];
      let currentDiscarded = [];
      try { currentPlatforms = JSON.parse(row.platforms || '[]'); } catch { /* vacío/corrupto */ }
      try { currentDiscarded = JSON.parse(row.platforms_discarded || '[]'); } catch { /* vacío/corrupto */ }

      // No pisar un archivo que YA tenga algo (evita perder algo que el pull
      // normal sí haya traído bien para los 51 pendientes).
      if (currentPlatforms.length > 0 || currentDiscarded.length > 0) { skippedHadData++; continue; }

      const central = byFileName.get(row.file_name);
      if (!central) { skippedNoMatch++; continue; }
      const centralPlatforms = central.platforms || [];
      const centralDiscarded = central.platforms_discarded || [];
      if (centralPlatforms.length === 0 && centralDiscarded.length === 0) { skippedNoMatch++; continue; }

      update.run(JSON.stringify(centralPlatforms), JSON.stringify(centralDiscarded), row.id);
      fixed++;
    }
  });
  txn(rows);

  console.log(`\nListo. ${fixed} corregidos, ${skippedHadData} ya tenían datos (no tocados), ${skippedNoMatch} sin coincidencia en la central.`);
  db.close();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
