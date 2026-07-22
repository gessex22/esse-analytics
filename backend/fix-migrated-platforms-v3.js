#!/usr/bin/env node
// Tercera pasada de platforms: las dos anteriores no alcanzaron (files.
// platforms de SQLite estaba vacía para la mayoría, backup_platform_videos
// en la central casi no tiene datos). Esta lee la tabla LOCAL
// `platform_videos` (JOIN files por linked_file_id) -- el registro real y
// completo de qué se publicó dónde, que la app de escritorio arma con el
// sync de cada plataforma. Es aditivo: solo AGREGA plataformas, nunca saca
// las que ya estaban.
//
// Corré esto en la PC (Windows) desde la carpeta `backend`, igual que los
// scripts anteriores.

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

const VALID_PLATFORMS = new Set(['youtube', 'instagram', 'tiktok']);

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
  const RemoteLibraryVideoModel = mongoose.model(
    'RemoteLibraryVideo',
    new mongoose.Schema({}, { strict: false }),
    'remote_library_videos',
  );

  const user = await UserModel.findOne({ username });
  if (!user) {
    console.error(`No existe el usuario "${username}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const userId = user._id.toString();

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    SELECT f.file_name AS file_name, pv.platform AS platform
    FROM platform_videos pv
    JOIN files f ON f.id = pv.linked_file_id
    WHERE pv.linked_file_id IS NOT NULL
  `).all();
  db.close();

  const platformsByFileName = new Map();
  for (const row of rows) {
    if (!VALID_PLATFORMS.has(row.platform)) continue;
    const existing = platformsByFileName.get(row.file_name) ?? new Set();
    existing.add(row.platform);
    platformsByFileName.set(row.file_name, existing);
  }
  console.log(`${platformsByFileName.size} nombres de archivo con al menos una publicación registrada en platform_videos.`);

  const videos = await RemoteLibraryVideoModel.find({ userId }).select('_id fileName platforms').lean();
  console.log(`${videos.length} videos en Nube para revisar.`);

  let fixed = 0, skipped = 0;
  for (const video of videos) {
    const foundPlatforms = platformsByFileName.get(video.fileName);
    if (!foundPlatforms) { skipped++; continue; }

    const current = new Set(video.platforms || []);
    const merged = new Set([...current, ...foundPlatforms]);
    if (merged.size === current.size) continue;

    await RemoteLibraryVideoModel.updateOne({ _id: video._id }, { $set: { platforms: Array.from(merged) } });
    fixed++;
    if (fixed % 100 === 0) console.log(`${fixed} corregidos...`);
  }

  console.log(`\nListo. ${fixed} corregidos, ${skipped} sin publicaciones registradas en platform_videos (no tocados).`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
