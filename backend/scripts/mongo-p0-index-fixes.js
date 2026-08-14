#!/usr/bin/env node
// Fixes P0 de docs/mongo-audit-2026-08-13.md:
//  1. platformvideos tiene el índice único legado {platform,platformId} además
//     del correcto {userId,platform,platformId} -- el legado bloquea que dos
//     usuarios distintos tengan el mismo ID nativo de plataforma. Se elimina.
//  2. platform_config no tiene índice único por {userId,platform} -- se crea.
//
// Antes de tocar nada, corre un preflight de solo lectura:
//  - Lista los índices actuales de ambas colecciones.
//  - Cuenta duplicados por (userId, platform) en platform_config (debe dar 0
//    para poder crear el índice único sin que falle).
//  - Cuenta cuántos platformId+platform están asociados a más de un userId
//    distinto en platformvideos (informativo -- hoy el índice legado lo hace
//    imposible por definición, así que debería dar siempre 0 mientras exista).
//
// Dry-run (default): node scripts/mongo-p0-index-fixes.js
// Aplicar:            node scripts/mongo-p0-index-fixes.js --apply

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

  // --- platformvideos: índices actuales ---
  const pvIndexes = await db.collection('platformvideos').indexes();
  console.log('Índices actuales en platformvideos:');
  console.log(JSON.stringify(pvIndexes, null, 2));

  const legacyIndex = pvIndexes.find((ix) => {
    const keys = Object.keys(ix.key);
    return keys.length === 2 && ix.key.platform === 1 && ix.key.platformId === 1;
  });
  const correctIndex = pvIndexes.find((ix) => {
    const keys = Object.keys(ix.key);
    return keys.length === 3 && ix.key.userId === 1 && ix.key.platform === 1 && ix.key.platformId === 1;
  });
  console.log(`\nÍndice legado {platform,platformId} encontrado: ${legacyIndex ? legacyIndex.name : 'NO ENCONTRADO'}`);
  console.log(`Índice correcto {userId,platform,platformId} encontrado: ${correctIndex ? correctIndex.name : 'NO ENCONTRADO'}`);

  // --- platformvideos: cuántos platform+platformId comparten más de un userId ---
  const crossUserCollisions = await db.collection('platformvideos').aggregate([
    { $group: { _id: { platform: '$platform', platformId: '$platformId' }, users: { $addToSet: '$userId' } } },
    { $match: { $expr: { $gt: [{ $size: '$users' }, 1] } } },
  ]).toArray();
  console.log(`\nCombinaciones platform+platformId con más de un userId distinto: ${crossUserCollisions.length}`);
  if (crossUserCollisions.length > 0) console.log(JSON.stringify(crossUserCollisions, null, 2));

  // --- platform_config: índices actuales ---
  const pcIndexes = await db.collection('platform_config').indexes();
  console.log('\nÍndices actuales en platform_config:');
  console.log(JSON.stringify(pcIndexes, null, 2));

  const pcUniqueExists = pcIndexes.some((ix) => {
    const keys = Object.keys(ix.key);
    return ix.unique && keys.length === 2 && ix.key.userId === 1 && ix.key.platform === 1;
  });
  console.log(`\nÍndice único {userId,platform} ya existe: ${pcUniqueExists}`);

  // --- platform_config: duplicados por (userId, platform) ---
  const pcDupes = await db.collection('platform_config').aggregate([
    { $group: { _id: { userId: '$userId', platform: '$platform' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  console.log(`\nDuplicados por (userId,platform) en platform_config: ${pcDupes.length}`);
  if (pcDupes.length > 0) console.log(JSON.stringify(pcDupes, null, 2));

  const safeToApply = crossUserCollisions.length === 0 && pcDupes.length === 0;

  console.log(`\n=== ${apply ? 'APLICANDO' : 'DRY-RUN (pasá --apply para escribir de verdad)'} ===\n`);

  if (!apply) {
    console.log(safeToApply
      ? 'Preflight OK -- correr de nuevo con --apply para ejecutar los dos fixes.'
      : 'Preflight encontró datos que bloquean el fix -- revisar antes de --apply.');
    await mongoose.disconnect();
    return;
  }

  if (!safeToApply) {
    console.error('ABORTADO: el preflight encontró colisiones/duplicados. No se tocó ningún índice.');
    await mongoose.disconnect();
    process.exit(1);
  }

  // Fix 1: eliminar el índice legado de platformvideos.
  if (legacyIndex) {
    console.log(`Eliminando índice legado platformvideos.${legacyIndex.name} ...`);
    await db.collection('platformvideos').dropIndex(legacyIndex.name);
    console.log('Eliminado. (Para revertir: db.platformvideos.createIndex({platform:1,platformId:1},{unique:true,name:"' + legacyIndex.name + '"}))');
  } else {
    console.log('No había índice legado que eliminar en platformvideos (ya estaba limpio).');
  }

  // Fix 2: crear el índice único en platform_config.
  if (!pcUniqueExists) {
    console.log('Creando índice único platform_config {userId:1,platform:1} ...');
    const name = await db.collection('platform_config').createIndex(
      { userId: 1, platform: 1 },
      { unique: true },
    );
    console.log(`Creado: ${name}. (Para revertir: db.platform_config.dropIndex("${name}"))`);
  } else {
    console.log('El índice único de platform_config ya existía.');
  }

  console.log('\n=== POSTFLIGHT ===\n');
  console.log('platformvideos:', JSON.stringify(await db.collection('platformvideos').indexes(), null, 2));
  console.log('platform_config:', JSON.stringify(await db.collection('platform_config').indexes(), null, 2));

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
