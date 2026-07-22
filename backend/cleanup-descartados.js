#!/usr/bin/env node
const path = require('path');
const os = require('os');
const fs = require('fs');
const readline = require('readline');

require('dotenv').config();

const CONFIRM = process.argv.includes('--confirm');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function getRemoteLibraryDir() {
  return process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');
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
  const discardedNames = db.prepare(`SELECT file_name FROM files WHERE content_status = 'descartado'`)
    .all().map(r => r.file_name);
  db.close();

  console.log(`${discardedNames.length} nombres marcados como descartado en la biblioteca local.`);
  if (discardedNames.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const toRemove = await RemoteLibraryVideoModel.find({
    userId,
    fileName: { $in: discardedNames },
  }).lean();

  console.log(`${toRemove.length} de esos están en Nube.`);
  if (toRemove.length === 0) {
    await mongoose.disconnect();
    return;
  }

  console.log(CONFIRM ? '\nBorrando:' : '\nSe borrarían (dry-run -- corré con --confirm para borrar de verdad):');
  const userDir = path.join(getRemoteLibraryDir(), userId);

  for (const video of toRemove) {
    console.log(`- ${video.fileName}`);
    if (!CONFIRM) continue;

    try { fs.unlinkSync(path.join(userDir, video.storedFileName)); } catch { /* no existía, no-op */ }
    if (video.thumbnailStoredFileName) {
      try { fs.unlinkSync(path.join(userDir, video.thumbnailStoredFileName)); } catch { /* no existía, no-op */ }
    }
    await RemoteLibraryVideoModel.deleteOne({ _id: video._id });
  }

  console.log(CONFIRM
    ? `\nListo. ${toRemove.length} borrados de Nube.`
    : '\nNada borrado todavía (dry-run). Revisá la lista de arriba y corré con --confirm para aplicar.');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
