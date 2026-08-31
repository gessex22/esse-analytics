#!/usr/bin/env node
// Preflight de SOLO LECTURA para SYNC-02#1 (content_id compartido, ver
// docs/SYNC-01-audit-2026-08-30.md y docs/mongo-remediation-review-2026-08-13.md,
// hallazgo H8). NO crea ni toca ningún índice -- ese es un paso aparte que
// todavía necesita resolver C4 (precedencia con backup_files.userId_1_file_name_1)
// antes de considerarse. Este script solo responde una pregunta: ¿hay HOY
// duplicados reales de {userId, content_id} en producción? Si la respuesta
// es 0 para ambas colecciones, el índice único parcial {userId,content_id}
// (excluyendo content_id: null) podría crearse sin fallar -- pero eso sigue
// siendo una decisión aparte, no algo que este script ejecute.
//
// Uso: node scripts/mongo-content-id-preflight.js

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI no está seteado');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log('\n=== PREFLIGHT content_id (SOLO LECTURA, no toca nada) ===\n');

  for (const collName of ['files', 'backup_files']) {
    const coll = db.collection(collName);

    const total = await coll.countDocuments();
    const withContentId = await coll.countDocuments({ content_id: { $exists: true, $ne: null } });
    console.log(`--- ${collName} ---`);
    console.log(`Documentos totales: ${total}`);
    console.log(`Con content_id seteado: ${withContentId}`);

    // Duplicados reales: mismo (userId, content_id) en más de un documento --
    // esto es exactamente lo que un índice único parcial {userId,content_id}
    // (partialFilterExpression: content_id existe) rechazaría al crearse.
    const dupes = await coll.aggregate([
      { $match: { content_id: { $exists: true, $ne: null } } },
      { $group: { _id: { userId: '$userId', content_id: '$content_id' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();
    console.log(`Duplicados por (userId, content_id): ${dupes.length}`);
    if (dupes.length > 0) console.log(JSON.stringify(dupes, null, 2));

    // Índices actuales -- informativo para la decisión de C4 (precedencia
    // con userId_1_file_name_1 en backup_files).
    const indexes = await coll.indexes();
    console.log(`Índices actuales en ${collName}:`);
    console.log(JSON.stringify(indexes, null, 2));
    console.log('');
  }

  // Cruce entre colecciones: un mismo (userId, content_id) que exista en
  // AMBAS colecciones no es un problema en sí (files y backup_files son
  // índices independientes), pero vale la pena verlo antes de decidir C4.
  const filesContentIds = await db.collection('files').distinct('content_id', { content_id: { $exists: true, $ne: null } });
  const backupContentIds = await db.collection('backup_files').distinct('content_id', { content_id: { $exists: true, $ne: null } });
  const overlap = filesContentIds.filter((id) => backupContentIds.includes(id));
  console.log(`content_id presentes en AMBAS colecciones (files ∩ backup_files): ${overlap.length} de ${filesContentIds.length} (files) / ${backupContentIds.length} (backup_files)`);

  console.log('\n=== FIN preflight -- no se modificó nada ===\n');
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
