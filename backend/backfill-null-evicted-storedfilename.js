#!/usr/bin/env node
// Backfill puntual: videos de Biblioteca remota liberados ANTES de que el
// almacenamiento dinámico empezara a poner storedFileName=null al liberar
// (ver remote-library-retention.service.ts) -- todavía tienen el
// storedFileName viejo en Mongo aunque el archivo ya no esté en disco, así
// que el filtro nuevo de listRemoteLibraryVideos no los oculta. Corrige eso
// una sola vez: si storedFileName apunta a un archivo que no existe, lo pone
// en null. No borra nada -- el archivo ya estaba borrado de antes.
//
// Uso: node backfill-null-evicted-storedfilename.js           (dry-run)
//      node backfill-null-evicted-storedfilename.js --apply

const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

async function main() {
  const apply = process.argv.includes('--apply');
  const mongoose = require('mongoose');
  const RemoteLibraryVideoModel = mongoose.model('RemoteLibraryVideo',
    new mongoose.Schema({}, { strict: false, timestamps: true }), 'remote_library_videos');

  await mongoose.connect(process.env.MONGO_URI);
  const remoteLibraryDir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');

  const videos = await RemoteLibraryVideoModel.find({ storedFileName: { $ne: null } })
    .select('userId storedFileName fileName').lean();

  let orphaned = 0, ok = 0;
  const ids = [];
  for (const v of videos) {
    const filePath = path.join(remoteLibraryDir, v.userId, v.storedFileName);
    if (fs.existsSync(filePath)) { ok++; continue; }
    orphaned++;
    ids.push(v._id);
  }

  console.log(`${videos.length} docs con storedFileName -- ${ok} con archivo real, ${orphaned} huérfanos (ya liberados antes del backfill).`);

  if (apply && ids.length) {
    const result = await RemoteLibraryVideoModel.updateMany({ _id: { $in: ids } }, { $set: { storedFileName: null } });
    console.log(`Actualizados: ${result.modifiedCount}`);
  } else if (!apply) {
    console.log('Dry-run -- no se tocó nada. Para aplicar: node backfill-null-evicted-storedfilename.js --apply');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
