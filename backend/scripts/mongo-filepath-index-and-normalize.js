#!/usr/bin/env node
// Ejecuta las dos partes del plan de docs/mongo-remediation-plan-2026-08-13.md
// que la revisión independiente (docs/mongo-remediation-review-2026-08-13.md)
// dejó aprobadas sin bloqueo -- el resto del plan (índice de content_id)
// sigue bloqueado, NO lo toca este script.
//
// Fase 3 — files.file_path: crea el índice único {userId,file_path} ANTES de
//   dropear el global file_path_1 (arregla H2: 55 placeholders de backup ya
//   colisionan hoy entre cuentas con el mismo nombre de archivo).
// Fase 5 (reducida) — normaliza los 19 documentos con platforms/
//   platforms_discarded ausentes a []. Por driver crudo (sin timestamps de
//   mongoose) para no bumpear updatedAt y no disparar una sincronización de
//   pull espuria en Electron. NO toca el archivo con 'facebook' en platforms
//   (ese no es un dato corrupto, ver docs/mongo-audit-2026-08-13.md).
//
// Dry-run (default): node scripts/mongo-filepath-index-and-normalize.js
// Aplicar:            node scripts/mongo-filepath-index-and-normalize.js --apply

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI no está seteado');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const apply = process.argv.includes('--apply');

  console.log(`\n=== PREFLIGHT (solo lectura) ===\n`);

  // --- Fase 3: índices actuales de files ---
  const filesIndexes = await db.collection('files').indexes();
  console.log('Índices actuales en files:');
  console.log(JSON.stringify(filesIndexes, null, 2));

  const globalPathIndex = filesIndexes.find((ix) => {
    const keys = Object.keys(ix.key);
    return keys.length === 1 && ix.key.file_path === 1 && ix.unique;
  });
  const perUserPathIndex = filesIndexes.find((ix) => {
    const keys = Object.keys(ix.key);
    return keys.length === 2 && ix.key.userId === 1 && ix.key.file_path === 1;
  });
  console.log(`\nÍndice global file_path_1 encontrado: ${globalPathIndex ? globalPathIndex.name : 'NO ENCONTRADO'}`);
  console.log(`Índice per-user {userId,file_path} ya existe: ${perUserPathIndex ? perUserPathIndex.name : 'NO'}`);

  // Duplicados por (userId, file_path) -- deben ser 0 para poder crear el único.
  const pathDupes = await db.collection('files').aggregate([
    { $group: { _id: { userId: '$userId', file_path: '$file_path' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  console.log(`\nDuplicados por (userId,file_path) en files: ${pathDupes.length}`);
  if (pathDupes.length > 0) console.log(JSON.stringify(pathDupes, null, 2));

  // --- Fase 5: documentos con arrays ausentes ---
  const missingPlatforms = await db.collection('files')
    .find({ platforms: { $exists: false } }, { projection: { file_name: 1, status: 1 } })
    .toArray();
  const missingDiscarded = await db.collection('files')
    .find({ platforms_discarded: { $exists: false } }, { projection: { file_name: 1, status: 1 } })
    .toArray();
  console.log(`\nfiles.platforms ausente: ${missingPlatforms.length} documentos`);
  console.log(JSON.stringify(missingPlatforms, null, 2));
  console.log(`\nfiles.platforms_discarded ausente: ${missingDiscarded.length} documentos`);
  console.log(JSON.stringify(missingDiscarded, null, 2));

  // Confirmar que ninguno de estos ids es el archivo con 'facebook' (no se toca).
  const facebookDoc = await db.collection('files').findOne({ platforms: 'facebook' }, { projection: { file_name: 1, platforms: 1 } });
  console.log(`\nArchivo con 'facebook' en platforms (NO se toca en este script): ${facebookDoc ? JSON.stringify(facebookDoc) : 'ninguno encontrado'}`);

  const safeToApply = pathDupes.length === 0;

  console.log(`\n=== ${apply ? 'APLICANDO' : 'DRY-RUN (pasá --apply para escribir de verdad)'} ===\n`);

  if (!apply) {
    console.log(safeToApply
      ? 'Preflight OK -- correr de nuevo con --apply para ejecutar Fase 3 y Fase 5.'
      : 'Preflight encontró duplicados de (userId,file_path) -- ABORTAR, no correr --apply todavía.');
    await mongoose.disconnect();
    return;
  }

  if (!safeToApply) {
    console.error('ABORTADO: hay duplicados de (userId,file_path). No se tocó nada.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // --- Fase 3 ---
  if (!perUserPathIndex) {
    console.log('Creando índice único files {userId:1,file_path:1} ...');
    const name = await db.collection('files').createIndex(
      { userId: 1, file_path: 1 },
      { unique: true },
    );
    console.log(`Creado: ${name}. (Rollback: db.files.dropIndex("${name}"))`);
  } else {
    console.log('El índice per-user de file_path ya existía, no se recreó.');
  }

  if (globalPathIndex) {
    console.log(`Eliminando índice global ${globalPathIndex.name} ...`);
    await db.collection('files').dropIndex(globalPathIndex.name);
    console.log(`Eliminado. (Rollback: db.files.createIndex({file_path:1},{unique:true,name:"${globalPathIndex.name}"}) -- solo funciona si no apareció ningún file_path duplicado entre usuarios desde este cambio)`);
  } else {
    console.log('No había índice global que eliminar (ya estaba limpio).');
  }

  // --- Fase 5 ---
  // Driver crudo (mongoose.connection.db, no el Model) -- no dispara los
  // timestamps de mongoose, así que updatedAt no se toca.
  if (missingPlatforms.length > 0) {
    console.log(`\nNormalizando platforms en ${missingPlatforms.length} documentos: ${JSON.stringify(missingPlatforms.map(d => d._id))}`);
    const r1 = await db.collection('files').updateMany({ platforms: { $exists: false } }, { $set: { platforms: [] } });
    console.log(`modifiedCount: ${r1.modifiedCount}`);
  }
  if (missingDiscarded.length > 0) {
    console.log(`\nNormalizando platforms_discarded en ${missingDiscarded.length} documentos: ${JSON.stringify(missingDiscarded.map(d => d._id))}`);
    const r2 = await db.collection('files').updateMany({ platforms_discarded: { $exists: false } }, { $set: { platforms_discarded: [] } });
    console.log(`modifiedCount: ${r2.modifiedCount}`);
  }
  console.log('\nRollback de Fase 5 (si hiciera falta), por _id de arriba:');
  console.log('  db.files.updateMany({_id:{$in:[...ids de platforms ausente...]}}, {$unset:{platforms:""}})');
  console.log('  db.files.updateMany({_id:{$in:[...ids de platforms_discarded ausente...]}}, {$unset:{platforms_discarded:""}})');

  console.log('\n=== POSTFLIGHT ===\n');
  console.log('files indexes:', JSON.stringify(await db.collection('files').indexes(), null, 2));
  const stillMissingP = await db.collection('files').countDocuments({ platforms: { $exists: false } });
  const stillMissingD = await db.collection('files').countDocuments({ platforms_discarded: { $exists: false } });
  console.log(`files.platforms ausente ahora: ${stillMissingP}`);
  console.log(`files.platforms_discarded ausente ahora: ${stillMissingD}`);

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
