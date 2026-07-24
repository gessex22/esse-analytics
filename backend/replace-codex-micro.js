#!/usr/bin/env node
// Reemplaza el video de "final - codex micro.mp4" en Biblioteca remota por la
// versión local nueva (re-render con el audio arreglado, confirmado a mano
// por fecha: local 2026-07-22 vs nube 2026-07-16). Hardlink, no copia -- mismo
// criterio que migrate-local-to-nube-copy.js, cero espacio extra.
//
// Uso: node replace-codex-micro.js           (dry-run)
//      node replace-codex-micro.js --apply   (aplica de verdad)

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const DOC_ID = '6a5f3243e4c2c52866c6dc2f';
const EXPECTED_OLD_STORED_NAME = '64b95385-b94b-428c-9114-4f877fb84099.mp4';
const LOCAL_PATH = 'C:\\Users\\Gessemberg\\Desktop\\publicados\\final - codex micro.mp4';
const EXPECTED_LOCAL_INO = 4785074605224538;
const EXPECTED_LOCAL_SIZE = 38627596;

async function main() {
  const apply = process.argv.includes('--apply');
  const mongoose = require('mongoose');
  const RemoteLibraryVideoModel = mongoose.model('RemoteLibraryVideo',
    new mongoose.Schema({}, { strict: false, timestamps: true }), 'remote_library_videos');

  await mongoose.connect(process.env.MONGO_URI);
  const remoteLibraryDir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');

  const doc = await RemoteLibraryVideoModel.findById(DOC_ID).lean();
  if (!doc) { console.log('El documento ya no existe -- abortado.'); await mongoose.disconnect(); return; }
  if (doc.storedFileName !== EXPECTED_OLD_STORED_NAME) {
    console.log(`storedFileName cambió (esperaba ${EXPECTED_OLD_STORED_NAME}, es ${doc.storedFileName}) -- abortado, algo lo tocó desde la última revisión.`);
    await mongoose.disconnect(); return;
  }

  const oldPath = path.join(remoteLibraryDir, doc.userId, doc.storedFileName);
  let oldStat;
  try { oldStat = fs.statSync(oldPath); } catch { console.log('El archivo viejo ya no está en disco -- abortado.'); await mongoose.disconnect(); return; }
  if (oldStat.nlink > 1) {
    console.log(`El archivo viejo tiene nlink=${oldStat.nlink} (>1) -- ya no es una copia única, no lo voy a tocar por las dudas. Abortado.`);
    await mongoose.disconnect(); return;
  }

  let localStat;
  try { localStat = fs.statSync(LOCAL_PATH); } catch { console.log('No encuentro el archivo local -- abortado.'); await mongoose.disconnect(); return; }
  if (localStat.ino !== EXPECTED_LOCAL_INO || localStat.size !== EXPECTED_LOCAL_SIZE) {
    console.log(`El archivo local cambió desde la revisión (ino/size no coinciden) -- abortado por seguridad.`);
    await mongoose.disconnect(); return;
  }

  const newStoredFileName = `${crypto.randomUUID()}.mp4`;
  const newPath = path.join(remoteLibraryDir, doc.userId, newStoredFileName);

  console.log(`Plan:
  1. Borrar el video viejo de Biblioteca remota (${oldPath}) -- audio bajo, obsoleto, única copia así que se pierde el archivo viejo (que ya no queremos).
  2. Hardlink del archivo local nuevo -> ${newPath}
  3. Actualizar el doc ${DOC_ID}: storedFileName, sizeBytes=${localStat.size}, durationSeconds=27.655, resolution=1080x1920, formato=VERTICAL`);

  if (!apply) {
    console.log('\nDry-run -- no se tocó nada. Para aplicar: node replace-codex-micro.js --apply');
    await mongoose.disconnect();
    return;
  }

  fs.unlinkSync(oldPath);
  fs.linkSync(LOCAL_PATH, newPath);

  await RemoteLibraryVideoModel.updateOne(
    { _id: DOC_ID },
    { $set: {
      storedFileName: newStoredFileName,
      sizeBytes: localStat.size,
      durationSeconds: 27.655,
      resolution: '1080x1920',
      formato: 'VERTICAL',
    } },
  );

  console.log(`\n[HECHO] Video viejo borrado, nuevo hardlinkeado como ${newStoredFileName}, doc actualizado.`);
  await mongoose.disconnect();
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
