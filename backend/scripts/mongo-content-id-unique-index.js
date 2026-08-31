#!/usr/bin/env node
// Fase 6 del plan de reconciliación de content_id (ver
// docs/SYNC-01-audit-2026-08-30.md, hallazgo SYNC-02#1). Sube el índice
// {userId,content_id} de files/backup_files de sparse-no-único a
// único-parcial (partialFilterExpression), igual que ya usa en producción
// remote-library-video.model.ts. Requisito: la divergencia histórica ya
// reconciliada por mongo-content-id-reconcile-backup-files.js (corrido
// 2026-08-31, 1033/1033 sin divergencia según el postflight).
//
// Preflight de solo lectura antes de tocar nada:
//  - Cuenta duplicados reales por (userId,content_id) en ambas colecciones
//    (debe dar 0 para poder crear el índice único sin que falle).
//  - Lista los índices actuales de ambas colecciones.
//
// Dry-run (default): node scripts/mongo-content-id-unique-index.js
// Aplicar:            node scripts/mongo-content-id-unique-index.js --apply

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

  let safeToApply = true;
  for (const collName of ['files', 'backup_files']) {
    const coll = db.collection(collName);
    const dupes = await coll.aggregate([
      { $match: { content_id: { $exists: true, $ne: null } } },
      { $group: { _id: { userId: '$userId', content_id: '$content_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();
    console.log(`${collName}: duplicados por (userId,content_id) = ${dupes.length}`);
    if (dupes.length > 0) { safeToApply = false; console.log(JSON.stringify(dupes, null, 2)); }

    const indexes = await coll.indexes();
    console.log(`${collName}: índices actuales:`, JSON.stringify(indexes.map(i => ({ name: i.name, key: i.key, unique: i.unique, sparse: i.sparse, partialFilterExpression: i.partialFilterExpression })), null, 2));
  }

  console.log(`\n=== ${apply ? 'APLICANDO' : 'DRY-RUN (pasá --apply para escribir de verdad)'} ===\n`);

  if (!apply) {
    console.log(safeToApply
      ? 'Preflight OK -- correr de nuevo con --apply para subir los índices a único-parcial.'
      : 'Preflight encontró duplicados -- correr mongo-content-id-reconcile-backup-files.js primero.');
    await mongoose.disconnect();
    return;
  }

  if (!safeToApply) {
    console.error('ABORTADO: hay duplicados. No se tocó ningún índice.');
    await mongoose.disconnect();
    process.exit(1);
  }

  for (const collName of ['files', 'backup_files']) {
    const coll = db.collection(collName);
    const indexes = await coll.indexes();

    // Índice viejo sparse-no-único de {userId,content_id} -- se borra antes
    // de crear el nuevo único-parcial con el mismo par de campos (Mongo no
    // permite dos índices con las mismas keys aunque difieran en opciones).
    const oldCompound = indexes.find(ix => {
      const keys = Object.keys(ix.key);
      return keys.length === 2 && ix.key.userId === 1 && ix.key.content_id === 1 && !ix.unique;
    });
    if (oldCompound) {
      console.log(`Eliminando índice viejo ${collName}.${oldCompound.name} ...`);
      await coll.dropIndex(oldCompound.name);
    }

    // Solo en `files`: el índice suelto {content_id:1} que auto-creaba el
    // `sparse:true` a nivel de campo en el schema viejo (ya sacado del
    // código, ver file.model.ts) -- redundante con el compuesto.
    const looseIndex = indexes.find(ix => {
      const keys = Object.keys(ix.key);
      return keys.length === 1 && ix.key.content_id === 1;
    });
    if (looseIndex) {
      console.log(`Eliminando índice suelto ${collName}.${looseIndex.name} ...`);
      await coll.dropIndex(looseIndex.name);
    }

    console.log(`Creando índice único-parcial ${collName} {userId:1,content_id:1} ...`);
    const name = await coll.createIndex(
      { userId: 1, content_id: 1 },
      { unique: true, partialFilterExpression: { content_id: { $type: 'string' } } },
    );
    console.log(`Creado: ${name}.`);
    console.log(`(Para revertir: db.${collName}.dropIndex("${name}"); ` +
      `db.${collName}.createIndex({userId:1,content_id:1}${collName === 'files' ? ',{sparse:true}' : ''});)`);
  }

  console.log('\n=== POSTFLIGHT ===\n');
  for (const collName of ['files', 'backup_files']) {
    console.log(`${collName}:`, JSON.stringify(await db.collection(collName).indexes(), null, 2));
  }

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
