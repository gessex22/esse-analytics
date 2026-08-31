#!/usr/bin/env node
// Fase 4 del plan de reconciliación de content_id (ver
// docs/SYNC-01-audit-2026-08-30.md, hallazgo SYNC-02#1). Corrige
// backup_files.content_id para que coincida con files.content_id en los
// casos clasificados 'seguro' por mongo-content-id-preflight-v2.js
// (evidencia externa de remote_library_videos/backup_platform_videos
// arbitra sin contradicción -- ver ese script para el detalle de cómo se
// llegó a la clasificación).
//
// Alcance verificado antes de escribir esto: ninguna otra colección
// (remote_library_videos, backup_platform_videos, upload_history)
// referencia el content_id VIEJO de backup_files -- todas ya apuntan al de
// `files`. La migración es un update de un solo campo en una sola
// colección, sin huérfanos que reparar en otro lado.
//
// Salvaguardas:
// - Dry-run por default. Hace falta --apply explícito para escribir.
// - Cada update va condicionado a que backup_files.content_id SIGA siendo
//   el valor que vimos en el preflight (evita pisar un cambio concurrente
//   hecho por otra sesión/proceso entre el preflight y esta corrida).
// - Excluye automáticamente cualquier registro que no sea 'seguro' con
//   canonical_guess === 'files' (los 'ambiguo'/'probable' quedan afuera).
// - Antes de aplicar, exporta un snapshot con los valores ANTERIORES
//   (para poder generar el rollback) a scripts/output/.
// - Después de aplicar, corre un postflight que confirma 0 divergencias
//   restantes en el set migrado.
// - Genera un script de rollback ejecutable a partir del mismo snapshot.
//
// Uso:
//   node scripts/mongo-content-id-reconcile-backup-files.js                (dry-run)
//   node scripts/mongo-content-id-reconcile-backup-files.js --apply        (aplica)
//   node scripts/mongo-content-id-reconcile-backup-files.js --input <ruta-a-json-alternativo>

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const inputIdx = args.indexOf('--input');
  const input = inputIdx >= 0 ? args[inputIdx + 1] : null;
  return { apply, input };
}

async function main() {
  const { apply, input } = parseArgs();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI no está seteado');

  const inputPath = input
    ? path.resolve(input)
    : path.join(__dirname, 'output', 'content-id-divergence-2026-08-31.json');
  if (!fs.existsSync(inputPath)) {
    throw new Error(`No se encontró el archivo de divergencias: ${inputPath} -- correr mongo-content-id-preflight-v2.js primero.`);
  }
  const divergent = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  const candidates = divergent.filter(d => d.classification === 'seguro' && d.canonical_guess === 'files');
  const skipped = divergent.length - candidates.length;
  console.log(`\n=== Reconciliación backup_files.content_id ===\n`);
  console.log(`Candidatos a migrar (seguro + canonical=files): ${candidates.length}`);
  console.log(`Excluidos (ambiguo/probable/otro canónico): ${skipped}`);

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  // Re-verifica en vivo que el valor actual de backup_files.content_id
  // sigue siendo el que vimos en el preflight -- si algo cambió desde
  // entonces (otra sesión, un push real del usuario), ese registro se
  // salta en vez de pisarlo a ciegas.
  const ids = candidates.map(c => new mongoose.Types.ObjectId(c.backup_files_id));
  const current = await db.collection('backup_files').find(
    { _id: { $in: ids } },
    { projection: { content_id: 1 } },
  ).toArray();
  const currentById = new Map(current.map(c => [String(c._id), c.content_id]));

  const toApply = [];
  const staleSkipped = [];
  for (const c of candidates) {
    const nowValue = currentById.get(c.backup_files_id);
    if (nowValue === c.backup_files_content_id) {
      toApply.push(c);
    } else {
      staleSkipped.push({ ...c, actual_current_content_id: nowValue ?? null });
    }
  }
  console.log(`Confirmados sin cambios desde el preflight: ${toApply.length}`);
  console.log(`Saltados por cambio concurrente detectado: ${staleSkipped.length}`);
  if (staleSkipped.length > 0) {
    console.log('Registros con cambio concurrente (no se tocan):');
    console.log(JSON.stringify(staleSkipped, null, 2));
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  // Snapshot ANTES -- necesario para el rollback exista o no --apply, para
  // poder revisar exactamente qué se hubiera tocado.
  const beforeSnapshot = toApply.map(c => ({
    backup_files_id: c.backup_files_id,
    userId: c.userId,
    file_name: c.file_name,
    content_id_before: c.backup_files_content_id,
    content_id_after: c.files_content_id,
  }));
  const beforePath = path.join(outDir, `content-id-reconcile-before-${stamp}.json`);
  fs.writeFileSync(beforePath, JSON.stringify(beforeSnapshot, null, 2));
  console.log(`\nSnapshot ANTES exportado a: ${beforePath}`);

  if (!apply) {
    console.log(`\n=== DRY-RUN (pasá --apply para escribir de verdad) ===`);
    console.log(`Se actualizarían ${toApply.length} documentos de backup_files.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\n=== APLICANDO ${toApply.length} actualizaciones ===\n`);
  let updated = 0, failed = 0;
  const errors = [];
  for (const c of toApply) {
    try {
      const result = await db.collection('backup_files').updateOne(
        { _id: new mongoose.Types.ObjectId(c.backup_files_id), content_id: c.backup_files_content_id },
        { $set: { content_id: c.files_content_id } },
      );
      if (result.modifiedCount === 1) updated++;
      else { failed++; errors.push({ ...c, reason: 'no matched/modified -- probablemente cambió justo antes de este update' }); }
    } catch (err) {
      failed++;
      errors.push({ ...c, reason: err.message });
    }
  }
  console.log(`Actualizados: ${updated}`);
  console.log(`Fallidos: ${failed}`);
  if (errors.length > 0) console.log('Errores:', JSON.stringify(errors, null, 2));

  // Postflight: confirma que los actualizados ya no divergen.
  const postIds = toApply.map(c => new mongoose.Types.ObjectId(c.backup_files_id));
  const postCheck = await db.collection('backup_files').find(
    { _id: { $in: postIds } },
    { projection: { content_id: 1, file_name: 1 } },
  ).toArray();
  const filesCheck = await db.collection('files').find(
    { _id: { $in: toApply.map(c => new mongoose.Types.ObjectId(c.files_id)) } },
    { projection: { content_id: 1 } },
  ).toArray();
  const filesContentById = new Map(filesCheck.map(f => [String(f._id), f.content_id]));
  let stillDivergent = 0;
  for (const c of toApply) {
    const post = postCheck.find(p => String(p._id) === c.backup_files_id);
    const filesNow = filesContentById.get(c.files_id);
    if (!post || post.content_id !== filesNow) stillDivergent++;
  }
  console.log(`\n=== POSTFLIGHT ===`);
  console.log(`Registros migrados que YA NO divergen: ${toApply.length - stillDivergent} de ${toApply.length}`);
  if (stillDivergent > 0) console.log(`⚠ ${stillDivergent} siguen divergiendo -- revisar antes de dar por cerrado.`);

  // Script de rollback generado del mismo snapshot -- restaura exactamente
  // los valores previos de los documentos que sí se actualizaron.
  const rollbackDocs = beforeSnapshot.filter(b => !errors.some(e => e.backup_files_id === b.backup_files_id));
  const rollbackPath = path.join(outDir, `content-id-reconcile-rollback-${stamp}.js`);
  const rollbackScript = `#!/usr/bin/env node
// Rollback generado automáticamente por mongo-content-id-reconcile-backup-files.js
// el ${new Date().toISOString()}. Restaura content_id de backup_files a los
// valores previos a esa migración. Dry-run por default, --apply para escribir.
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const docs = ${JSON.stringify(rollbackDocs, null, 2)};
async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(\`\${apply ? 'Restaurando' : 'DRY-RUN, restauraría'} \${docs.length} documentos...\`);
  if (apply) {
    for (const d of docs) {
      await db.collection('backup_files').updateOne(
        { _id: new mongoose.Types.ObjectId(d.backup_files_id) },
        { \$set: { content_id: d.content_id_before } },
      );
    }
    console.log('Rollback aplicado.');
  }
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
`;
  fs.writeFileSync(rollbackPath, rollbackScript);
  console.log(`\nScript de rollback generado en: ${rollbackPath}`);

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
