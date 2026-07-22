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
  // SIN timestamps:true a propósito -- con esa opción, Mongoose intercepta
  // updateOne() y descarta cualquier $set a createdAt para "protegerlo"
  // (solo deja tocar updatedAt). Eso hacía que este script reportara éxito
  // sin cambiar nada. Acá se está escribiendo createdAt a mano, así que el
  // plugin de timestamps debe estar apagado en este modelo puntual.
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
    db.prepare(`SELECT file_name, fecha_creacion, created_at FROM files`).all()
      .map(r => [r.file_name, r.fecha_creacion || r.created_at]),
  );
  db.close();

  const videos = await RemoteLibraryVideoModel.find({ userId }).select('_id fileName createdAt').lean();
  console.log(`${videos.length} videos en Nube para revisar.`);

  let fixed = 0, skipped = 0;
  for (const [i, video] of videos.entries()) {
    const realDate = localByName.get(video.fileName);
    if (!realDate) {
      skipped++;
      continue;
    }
    const parsed = new Date(realDate);
    if (isNaN(parsed.getTime())) {
      skipped++;
      continue;
    }
    const current = new Date(video.createdAt);
    if (Math.abs(current.getTime() - parsed.getTime()) < 1000) continue;

    await RemoteLibraryVideoModel.updateOne({ _id: video._id }, { $set: { createdAt: parsed } });
    fixed++;
    if (fixed % 100 === 0) console.log(`${fixed} corregidos...`);
  }

  console.log(`\nListo. ${fixed} fechas corregidas, ${skipped} sin fecha local para comparar (no tocados).`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
