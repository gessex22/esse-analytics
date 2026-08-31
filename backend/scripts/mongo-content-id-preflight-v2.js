#!/usr/bin/env node
// Fase 2 ampliada del preflight de content_id (ver
// docs/SYNC-01-audit-2026-08-30.md, plan de 7 fases acordado 2026-08-31).
// SOLO LECTURA -- no crea índices, no escribe nada, no tiene --apply.
//
// Para cada par (userId, file_name) donde files.content_id != backup_files.content_id,
// junta evidencia cruzada de todo el grafo de datos (remote_library_videos,
// upload_history, backup_platform_videos, platformvideos) para clasificar
// cada caso como seguro / probable / ambiguo -- SIN asumir que ninguna
// colección gana por defecto. La comparación contra el SQLite de la PC
// primaria NO está acá (necesita acceso directo a esa máquina) -- queda
// pendiente como paso separado.
//
// Uso: node scripts/mongo-content-id-preflight-v2.js
// Exporta el detalle completo a scripts/output/content-id-divergence-<fecha>.json

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function sameMetadata(a, b) {
  if (!a || !b) return false;
  const durA = a.duracion_segundos, durB = b.duracion_segundos;
  const durOk = durA != null && durB != null ? Math.abs(durA - durB) <= 2 : durA == null && durB == null;
  const fmtOk = (a.formato ?? null) === (b.formato ?? null);
  const resOk = (a.resolucion ?? null) === (b.resolucion ?? null);
  return durOk && fmtOk && resOk;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI no está seteado');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log('\n=== FASE 2 AMPLIADA -- preflight content_id (SOLO LECTURA) ===\n');

  const projection = {
    userId: 1, file_name: 1, content_id: 1,
    duracion_segundos: 1, fecha_creacion: 1, formato: 1, resolucion: 1,
  };
  const files = await db.collection('files').find({}, { projection }).toArray();
  const backups = await db.collection('backup_files').find({}, { projection }).toArray();

  // Duplicados por (userId, file_name) DENTRO de `files` -- distinto de
  // duplicados por content_id (ya cubierto en el preflight v1). Si el mismo
  // nombre aparece más de una vez para el mismo usuario en `files`, cualquier
  // comparación por nombre es ambigua de entrada para esas filas.
  const filesByUserName = new Map();
  for (const f of files) {
    const key = `${f.userId}::${f.file_name}`;
    if (!filesByUserName.has(key)) filesByUserName.set(key, []);
    filesByUserName.get(key).push(f);
  }
  const dupeNameKeys = new Set([...filesByUserName.entries()].filter(([, v]) => v.length > 1).map(([k]) => k));
  console.log(`Duplicados por (userId, file_name) dentro de 'files': ${dupeNameKeys.size} nombre(s) con más de un documento.`);

  const backupByKey = new Map(backups.map(b => [`${b.userId}::${b.file_name}`, b]));

  // Índices auxiliares para evidencia cruzada -- todo por (userId, fileName/file_name).
  const remoteVideos = await db.collection('remote_library_videos').find({}, { projection: { userId: 1, fileName: 1, contentId: 1 } }).toArray();
  const remoteByKey = new Map();
  for (const r of remoteVideos) {
    const key = `${r.userId}::${r.fileName}`;
    if (!remoteByKey.has(key)) remoteByKey.set(key, []);
    remoteByKey.get(key).push(r.contentId ?? null);
  }

  const historyEvents = await db.collection('upload_history').find({ contentId: { $exists: true, $ne: null } }, { projection: { userId: 1, fileName: 1, contentId: 1 } }).toArray();
  const historyByKey = new Map();
  for (const h of historyEvents) {
    const key = `${h.userId}::${h.fileName}`;
    if (!historyByKey.has(key)) historyByKey.set(key, []);
    historyByKey.get(key).push(h.contentId);
  }

  const backupPlatformVideos = await db.collection('backup_platform_videos').find({ content_id: { $exists: true, $ne: null } }, { projection: { userId: 1, file_name: 1, content_id: 1 } }).toArray();
  const bpvByKey = new Map();
  for (const b of backupPlatformVideos) {
    const key = `${b.userId}::${b.file_name}`;
    if (!bpvByKey.has(key)) bpvByKey.set(key, []);
    bpvByKey.get(key).push(b.content_id);
  }

  // platformvideos.linkedFileId -> files._id (ObjectId), no por content_id.
  // Sirve para saber si la fila de `files` en cuestión tiene links reales de
  // publicación (evidencia de que es la fila "viva", más allá de cuál
  // content_id tenga).
  const platformVideoCounts = await db.collection('platformvideos').aggregate([
    { $match: { linkedFileId: { $ne: null } } },
    { $group: { _id: '$linkedFileId', count: { $sum: 1 } } },
  ]).toArray();
  const linkedCountById = new Map(platformVideoCounts.map(p => [String(p._id), p.count]));

  const results = [];
  let seguro = 0, probable = 0, ambiguo = 0;

  for (const f of files) {
    const key = `${f.userId}::${f.file_name}`;
    const b = backupByKey.get(key);
    if (!b || !f.content_id || !b.content_id || f.content_id === b.content_id) continue; // solo los divergentes reales

    const remoteIds = remoteByKey.get(key) ?? [];
    const historyIds = historyByKey.get(key) ?? [];
    const bpvIds = bpvByKey.get(key) ?? [];
    const allExternal = [...remoteIds, ...historyIds, ...bpvIds].filter(Boolean);

    const matchesFiles = allExternal.filter(id => id === f.content_id).length;
    const matchesBackup = allExternal.filter(id => id === b.content_id).length;
    const linkedPlatformVideos = linkedCountById.get(String(f._id)) ?? 0;
    const nameIsDupeInFiles = dupeNameKeys.has(key);
    const metadataSame = sameMetadata(f, b);

    let classification, canonical;
    if (nameIsDupeInFiles) {
      classification = 'ambiguo'; canonical = null; // el nombre ni siquiera es único en `files` para este usuario
    } else if (matchesFiles > 0 && matchesBackup === 0) {
      classification = 'seguro'; canonical = 'files';
    } else if (matchesBackup > 0 && matchesFiles === 0) {
      classification = 'seguro'; canonical = 'backup_files';
    } else if (matchesFiles > 0 && matchesBackup > 0) {
      classification = 'ambiguo'; canonical = null; // evidencia contradictoria entre sí
    } else if (metadataSame) {
      classification = 'probable'; canonical = null; // mismo archivo físico probable, pero sin fuente externa que arbitre cuál id
    } else {
      classification = 'ambiguo'; canonical = null; // sin evidencia externa Y metadata distinta -- podría ni ser el mismo archivo
    }

    if (classification === 'seguro') seguro++;
    else if (classification === 'probable') probable++;
    else ambiguo++;

    results.push({
      userId: f.userId,
      file_name: f.file_name,
      files_id: f._id,
      files_content_id: f.content_id,
      files_metadata: { duracion_segundos: f.duracion_segundos, fecha_creacion: f.fecha_creacion, formato: f.formato, resolucion: f.resolucion },
      backup_files_id: b._id,
      backup_files_content_id: b.content_id,
      backup_files_metadata: { duracion_segundos: b.duracion_segundos, fecha_creacion: b.fecha_creacion, formato: b.formato, resolucion: b.resolucion },
      remote_library_videos_contentIds: remoteIds,
      upload_history_contentIds: historyIds,
      backup_platform_videos_content_ids: bpvIds,
      linked_platformvideos_count_on_files_id: linkedPlatformVideos,
      name_duplicated_in_files: nameIsDupeInFiles,
      metadata_matches: metadataSame,
      classification,
      canonical_guess: canonical,
    });
  }

  console.log(`\nTotal divergentes analizados: ${results.length}`);
  console.log(`  seguro:   ${seguro} (evidencia externa arbitra sin contradicción)`);
  console.log(`  probable: ${probable} (mismo archivo por metadata, sin fuente externa)`);
  console.log(`  ambiguo:  ${ambiguo} (sin evidencia, contradictorio, o nombre duplicado en 'files')`);

  const canonicalCounts = results.reduce((acc, r) => {
    if (r.canonical_guess) acc[r.canonical_guess] = (acc[r.canonical_guess] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nDe los 'seguro', canónico sugerido:`, JSON.stringify(canonicalCounts));

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `content-id-divergence-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\nDetalle completo (${results.length} registros) exportado a: ${outFile}`);

  console.log('\n=== FIN -- no se modificó nada ===\n');
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
