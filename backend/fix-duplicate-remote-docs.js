#!/usr/bin/env node
// Dos arreglos relacionados con que la migración original
// (migrate-local-to-nube-copy.js) nunca guardó contentId:
//
// 1. Merge puntual: stargate/oneplus quedaron duplicados (doc viejo con
//    miniatura pero sin bytes/contentId, doc nuevo con bytes pero sin
//    miniatura) porque ensureNextVideoInRemoteLibrary busca "ya existe" por
//    contentId y el viejo no lo tiene. Se le pasa la miniatura al nuevo y se
//    borra el viejo (ya no sirve para nada, sin bytes y redundante).
//
// 2. Backfill: todos los demás docs de la migración original que todavía no
//    tienen contentId se lo completan (cruzando por fileName contra la
//    SQLite local, SOLO cuando el nombre es único de los dos lados) -- así
//    la próxima vez que cualquiera de esos videos vuelva a ser "el próximo",
//    ensureNextVideoInRemoteLibrary lo va a encontrar por contentId y no va
//    a crear otro duplicado.
//
// Uso: node fix-duplicate-remote-docs.js           (dry-run)
//      node fix-duplicate-remote-docs.js --apply

const path = require('path');
const os = require('os');
require('dotenv').config();

const MERGE_PAIRS = [
  { fileName: 'final - stargate.mp4', oldId: '6a5f3237e4c2c52866c6da80', newId: '6a62c01aca4afd00366150f1' },
  { fileName: 'final - oneplus.mp4',  oldId: '6a5f3243e4c2c52866c6dc30', newId: '6a62c01aca4afd00366150f2' },
];

async function main() {
  const apply = process.argv.includes('--apply');
  const mongoose = require('mongoose');
  const Database = (() => {
    try { return require('better-sqlite3'); } catch { return require(path.join('..', 'local-backend', 'node_modules', 'better-sqlite3')); }
  })();

  const RemoteLibraryVideoModel = mongoose.model('RemoteLibraryVideo',
    new mongoose.Schema({}, { strict: false, timestamps: true }), 'remote_library_videos');

  await mongoose.connect(process.env.MONGO_URI);

  console.log('=== Paso 1: merge stargate/oneplus ===');
  for (const pair of MERGE_PAIRS) {
    const oldDoc = await RemoteLibraryVideoModel.findById(pair.oldId).lean();
    const newDoc = await RemoteLibraryVideoModel.findById(pair.newId).lean();
    if (!oldDoc || !newDoc) { console.log(`[SALTEADO] ${pair.fileName} -- no encuentro alguno de los 2 docs`); continue; }
    if (!oldDoc.thumbnailStoredFileName) { console.log(`[SALTEADO] ${pair.fileName} -- el viejo no tiene miniatura, nada que pasar`); continue; }

    console.log(`[${apply ? 'MERGEANDO' : 'SIMULARÍA MERGEAR'}] ${pair.fileName}: miniatura ${oldDoc.thumbnailStoredFileName} -> doc nuevo, borro doc viejo ${pair.oldId}`);
    if (apply) {
      await RemoteLibraryVideoModel.updateOne({ _id: pair.newId }, { $set: { thumbnailStoredFileName: oldDoc.thumbnailStoredFileName } });
      await RemoteLibraryVideoModel.deleteOne({ _id: pair.oldId });
    }
  }

  console.log('\n=== Paso 2: backfill de contentId en docs viejos sin contentId ===');
  const sqlitePath = process.env.SQLITE_PATH || path.join(os.homedir(), 'AppData', 'Roaming', 'esse-analytics-desktop', 'esse_local.db');
  const db = new Database(sqlitePath, { readonly: true });
  const localRows = db.prepare('SELECT file_name, content_id FROM files WHERE content_id IS NOT NULL').all();
  db.close();

  const localCountByName = new Map();
  const localContentIdByName = new Map();
  for (const r of localRows) {
    localCountByName.set(r.file_name, (localCountByName.get(r.file_name) ?? 0) + 1);
    localContentIdByName.set(r.file_name, r.content_id);
  }

  const withoutContentId = await RemoteLibraryVideoModel.find({ contentId: { $in: [null, undefined] } }).select('fileName').lean();
  const remoteCountByName = new Map();
  for (const v of withoutContentId) remoteCountByName.set(v.fileName, (remoteCountByName.get(v.fileName) ?? 0) + 1);

  let backfilled = 0, skippedAmbiguous = 0, skippedNoLocalMatch = 0;
  for (const v of withoutContentId) {
    if ((remoteCountByName.get(v.fileName) ?? 0) > 1) { skippedAmbiguous++; continue; } // ambiguo del lado remoto también
    const localCount = localCountByName.get(v.fileName) ?? 0;
    if (localCount !== 1) { skippedNoLocalMatch++; continue; } // no existe local, o también ambiguo local
    const contentId = localContentIdByName.get(v.fileName);
    backfilled++;
    if (apply) {
      await RemoteLibraryVideoModel.updateMany({ fileName: v.fileName, contentId: { $in: [null, undefined] } }, { $set: { contentId } });
    }
  }

  console.log(`${withoutContentId.length} docs sin contentId -- ${backfilled} completados, ${skippedAmbiguous} ambiguos (remoto), ${skippedNoLocalMatch} sin match local único.`);
  if (!apply) console.log('\nDry-run -- no se tocó nada. Para aplicar: node fix-duplicate-remote-docs.js --apply');

  await mongoose.disconnect();
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
