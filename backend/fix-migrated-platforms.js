#!/usr/bin/env node
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
  const localByName = new Map(
    db.prepare(`SELECT file_name, platforms FROM files`).all()
      .map(r => [r.file_name, r.platforms]),
  );
  db.close();

  const videos = await RemoteLibraryVideoModel.find({ userId })
    .select('_id fileName platforms').lean();
  console.log(`${videos.length} videos en Nube para revisar.`);

  let fixed = 0, skipped = 0;
  for (const video of videos) {
    const raw = localByName.get(video.fileName);
    if (!raw) { skipped++; continue; }

    let platforms;
    try {
      platforms = JSON.parse(raw).filter(p => VALID_PLATFORMS.has(p));
    } catch {
      skipped++;
      continue;
    }

    const current = new Set(video.platforms || []);
    const same = platforms.length === current.size && platforms.every(p => current.has(p));
    if (same) continue;

    await RemoteLibraryVideoModel.updateOne({ _id: video._id }, { $set: { platforms } });
    fixed++;
    if (fixed % 100 === 0) console.log(`${fixed} corregidos...`);
  }

  console.log(`\nListo. ${fixed} corregidos, ${skipped} sin datos locales para comparar (no tocados).`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
