#!/usr/bin/env node
// Migración de datos para BUG-2026-08-15-03 (docs/bug-reports.md) --
// backfillea el campo nuevo `platform_states`/`platformStates` (ver
// backend/src/utils/platform-state.util.ts) en documentos existentes de
// `files` y `remote_library_videos` que todavía no lo tienen (sparse a
// propósito, ver los modelos).
//
// Criterio de derivación (mismo que usa el código nuevo en caliente):
//   - files: por cada `platform` en `platforms[]`, 'confirmed' si existe un
//     PlatformVideoModel con `linkedFileId` = este archivo y ese `platform`
//     (identidad de publicación real), si no 'badge_only'. Cada `platform`
//     en `platforms_discarded[]` -> 'discarded'.
//   - remote_library_videos: por cada `platform` en `platforms[]`,
//     'confirmed' si hay un `platformLinks` con ese `platform`, si no
//     'badge_only'. Cada `platform` en `platformsDiscarded[]` -> 'discarded'.
//
// Dry-run (default): node scripts/mongo-platform-states-migration.js
// Aplicar:            node scripts/mongo-platform-states-migration.js --apply

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function deriveFileStates(doc, confirmedKeysForThisFile) {
  const states = [];
  for (const p of (doc.platforms ?? [])) {
    states.push({ platform: p, state: confirmedKeysForThisFile.has(p) ? 'confirmed' : 'badge_only' });
  }
  for (const p of (doc.platforms_discarded ?? [])) {
    if (states.find((s) => s.platform === p)) continue; // no debería pasar (mismo platform en los 2 arrays), pero no pisar si pasa
    states.push({ platform: p, state: 'discarded' });
  }
  return states;
}

function deriveRemoteStates(doc) {
  const linkedPlatforms = new Set((doc.platformLinks ?? []).map((l) => l.platform));
  const states = [];
  for (const p of (doc.platforms ?? [])) {
    states.push({ platform: p, state: linkedPlatforms.has(p) ? 'confirmed' : 'badge_only' });
  }
  for (const p of (doc.platformsDiscarded ?? [])) {
    if (states.find((s) => s.platform === p)) continue;
    states.push({ platform: p, state: 'discarded' });
  }
  return states;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI no está seteado');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const apply = process.argv.includes('--apply');

  console.log(`\n=== PREFLIGHT (solo lectura) ===\n`);

  const filesToMigrate = await db.collection('files')
    .find({ platform_states: { $exists: false }, $or: [{ 'platforms.0': { $exists: true } }, { 'platforms_discarded.0': { $exists: true } }] })
    .project({ file_name: 1, platforms: 1, platforms_discarded: 1 })
    .toArray();
  const remoteToMigrate = await db.collection('remote_library_videos')
    .find({ platformStates: { $exists: false }, $or: [{ 'platforms.0': { $exists: true } }, { 'platformsDiscarded.0': { $exists: true } }] })
    .project({ fileName: 1, platforms: 1, platformsDiscarded: 1, platformLinks: 1 })
    .toArray();

  console.log(`files sin platform_states con algo que migrar: ${filesToMigrate.length}`);
  console.log(`remote_library_videos sin platformStates con algo que migrar: ${remoteToMigrate.length}`);

  // Mapa fileId|platform -> confirmado, a partir de PlatformVideoModel real
  // (linkedFileId + platform es la identidad real de publicación).
  const linkedDocs = await db.collection('platformvideos')
    .find({ linkedFileId: { $ne: null } })
    .project({ linkedFileId: 1, platform: 1 })
    .toArray();
  const confirmedByFile = new Map(); // fileId string -> Set<platform>
  for (const d of linkedDocs) {
    const key = String(d.linkedFileId);
    if (!confirmedByFile.has(key)) confirmedByFile.set(key, new Set());
    confirmedByFile.get(key).add(d.platform);
  }
  console.log(`PlatformVideoModel con linkedFileId real: ${linkedDocs.length} (${confirmedByFile.size} archivos distintos)`);

  let previewConfirmed = 0, previewBadgeOnly = 0, previewDiscarded = 0;
  const fileOps = filesToMigrate.map((doc) => {
    const confirmedSet = confirmedByFile.get(String(doc._id)) ?? new Set();
    const states = deriveFileStates(doc, confirmedSet);
    previewConfirmed += states.filter((s) => s.state === 'confirmed').length;
    previewBadgeOnly += states.filter((s) => s.state === 'badge_only').length;
    previewDiscarded += states.filter((s) => s.state === 'discarded').length;
    return { updateOne: { filter: { _id: doc._id }, update: { $set: { platform_states: states } } } };
  });
  let previewRConfirmed = 0, previewRBadgeOnly = 0, previewRDiscarded = 0;
  const remoteOps = remoteToMigrate.map((doc) => {
    const states = deriveRemoteStates(doc);
    previewRConfirmed += states.filter((s) => s.state === 'confirmed').length;
    previewRBadgeOnly += states.filter((s) => s.state === 'badge_only').length;
    previewRDiscarded += states.filter((s) => s.state === 'discarded').length;
    return { updateOne: { filter: { _id: doc._id }, update: { $set: { platformStates: states } } } };
  });

  console.log(`\nPreview files: ${previewConfirmed} confirmed, ${previewBadgeOnly} badge_only, ${previewDiscarded} discarded`);
  console.log(`Preview remote_library_videos: ${previewRConfirmed} confirmed, ${previewRBadgeOnly} badge_only, ${previewRDiscarded} discarded`);
  if (filesToMigrate.length > 0) {
    console.log('\nEjemplo files (hasta 3):');
    console.log(JSON.stringify(fileOps.slice(0, 3), null, 2));
  }
  if (remoteToMigrate.length > 0) {
    console.log('\nEjemplo remote_library_videos (hasta 3):');
    console.log(JSON.stringify(remoteOps.slice(0, 3), null, 2));
  }

  console.log(`\n=== ${apply ? 'APLICANDO' : 'DRY-RUN (pasá --apply para escribir de verdad)'} ===\n`);
  if (!apply) {
    console.log('Preflight OK -- correr de nuevo con --apply para escribir platform_states/platformStates.');
    await mongoose.disconnect();
    return;
  }

  if (fileOps.length > 0) {
    const r1 = await db.collection('files').bulkWrite(fileOps, { ordered: false });
    console.log(`files modificados: ${r1.modifiedCount}`);
  }
  if (remoteOps.length > 0) {
    const r2 = await db.collection('remote_library_videos').bulkWrite(remoteOps, { ordered: false });
    console.log(`remote_library_videos modificados: ${r2.modifiedCount}`);
  }

  console.log('\nRollback (si hiciera falta), por _id de arriba:');
  console.log('  db.files.updateMany({_id:{$in:[...]}}, {$unset:{platform_states:""}})');
  console.log('  db.remote_library_videos.updateMany({_id:{$in:[...]}}, {$unset:{platformStates:""}})');

  console.log('\n=== POSTFLIGHT ===\n');
  const stillMissingFiles = await db.collection('files').countDocuments({
    platform_states: { $exists: false },
    $or: [{ 'platforms.0': { $exists: true } }, { 'platforms_discarded.0': { $exists: true } }],
  });
  const stillMissingRemote = await db.collection('remote_library_videos').countDocuments({
    platformStates: { $exists: false },
    $or: [{ 'platforms.0': { $exists: true } }, { 'platformsDiscarded.0': { $exists: true } }],
  });
  console.log(`files sin platform_states (con algo que migrar) ahora: ${stillMissingFiles}`);
  console.log(`remote_library_videos sin platformStates (con algo que migrar) ahora: ${stillMissingRemote}`);

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
