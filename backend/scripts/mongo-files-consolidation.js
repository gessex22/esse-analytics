#!/usr/bin/env node
// mongo-files-consolidation.js -- Entrega B de
// docs/mongo-collections-consolidation-plan-2026-09-02.md (secciones 4-7).
//
// Migra hacia `files` (colección canónica) los campos que hoy solo viven en
// `backup_files`, aplicando las reglas de merge de la sección 4. NO borra
// nada de `backup_files` (eso es Entrega D, script separado). Los 5 campos
// nuevos ya existen en FileSchema desde la Entrega A y cada push nuevo desde
// entonces ya se auto-completa solo -- este script es específicamente para
// el backlog histórico: documentos de `files` que no recibieron ningún push
// desde que la Entrega A quedó activa.
//
// Salvaguardas (sección 4-7 del plan):
// - Dry-run por default. Hace falta --apply explícito para escribir.
// - Snapshot COMPLETO de `backup_files` obligatorio antes de cualquier
//   --apply -- reemplaza al shadow-write en vivo como mecanismo de rollback
//   (sección 1). Sin este paso el script se niega a aplicar.
// - Cada update va condicionado a `_id` + el `updatedAt` observado en el
//   preflight (concurrencia optimista) -- si cambió entre medio, se clasifica
//   `concurrent_change` y NO se pisa el push que ganó la carrera.
// - Salida separada en 4 buckets: safe / ambiguous / collision / error, más
//   `orphan` (informativo, no es uno de los 4 del plan porque no corresponde
//   a ninguna escritura).
// - `ambiguous` no bloquea el resto de la corrida (rule 10) ni es un estado
//   terminal (sección "Salida finita del bucket ambiguous"): un documento
//   ambiguo completo queda afuera del apply hasta tener una resolución en
//   resolutions-<runId>.json; el resto de los documentos sigue su curso.
// - El apply GLOBAL (sin --user-id ni --limit) exige cero ambiguos sin
//   resolver. Un canary (con --user-id/--limit) puede avanzar con ambiguos
//   pendientes -- esos documentos puntuales simplemente no se tocan todavía.
// - Reentrante: una segunda corrida recalcula el estado actual y no reaplica
//   lo que ya coincide con lo deseado (no-op), sin duplicar nada.
// - Lock de un solo proceso a la vez vía la colección `_migration_locks`.
//
// Uso:
//   cd backend
//   node scripts/mongo-files-consolidation.js                         (preflight + dry-run, todos los usuarios)
//   node scripts/mongo-files-consolidation.js --user-id <id>          (preflight + dry-run, un usuario/canary)
//   node scripts/mongo-files-consolidation.js --user-id <id> --apply  (aplica sobre ese canary)
//   node scripts/mongo-files-consolidation.js --apply                 (apply GLOBAL -- exige 0 ambiguos sin resolver)
//   node scripts/mongo-files-consolidation.js --resolutions <ruta> --apply
//   node scripts/mongo-files-consolidation.js --resume <runId> ...    (reusa el runId para nombrar archivos + auto-carga resolutions-<runId>.json si existe)
//   node scripts/mongo-files-consolidation.js --generate-resolutions-template   (solo dry-run: escribe resolutions-<runId>.json editable a partir de los ambiguos encontrados)

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const OUT_DIR = path.join(__dirname, 'output');
const LOCK_COLLECTION = '_migration_locks';
const LOCK_ID = 'mongo-files-consolidation';
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min -- una corrida real no debería tardar tanto; permite recuperarse solo de un proceso que murió sin liberar el lock.
const TECHNICAL_FIELDS = ['duracion_segundos', 'resolucion', 'formato', 'fecha_creacion'];

function parseArgs() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };
  return {
    apply: flag('--apply'),
    userId: value('--user-id'),
    limit: value('--limit') ? Number(value('--limit')) : null,
    resolutionsPath: value('--resolutions'),
    resume: value('--resume'),
    generateTemplate: flag('--generate-resolutions-template'),
    help: flag('--help') || flag('-h'),
  };
}

function newRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function writeJson(name, data) {
  ensureOutDir();
  const filePath = path.join(OUT_DIR, name);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

function writeNdjson(name, rows) {
  ensureOutDir();
  const filePath = path.join(OUT_DIR, name);
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return filePath;
}

// ── Lock de un solo proceso ────────────────────────────────────────────────
// No es un lock distribuido sofisticado -- alcanza para impedir que dos
// invocaciones de ESTE script corran al mismo tiempo contra la misma base.
// El resume (--resume <runId>) es solo una convención de nombrado de
// archivos de salida, no mantiene el lock tomado entre invocaciones
// distintas del proceso.
async function acquireLock(db, runId) {
  const col = db.collection(LOCK_COLLECTION);
  const existing = await col.findOne({ _id: LOCK_ID });
  if (existing) {
    const age = Date.now() - new Date(existing.startedAt).getTime();
    if (age < LOCK_STALE_MS) {
      throw new Error(
        `Ya hay una corrida en curso (runId=${existing.runId}, pid=${existing.pid}, hace ${Math.round(age / 1000)}s). ` +
        `Si ese proceso murió, esperá ${Math.round((LOCK_STALE_MS - age) / 1000)}s más o borrá manualmente el doc _id="${LOCK_ID}" de ${LOCK_COLLECTION}.`,
      );
    }
    console.warn(`⚠ Lock previo stale (runId=${existing.runId}, hace ${Math.round(age / 1000)}s) -- se toma de nuevo.`);
    await col.deleteOne({ _id: LOCK_ID });
  }
  await col.insertOne({ _id: LOCK_ID, runId, startedAt: new Date(), pid: process.pid });
}

async function releaseLock(db, runId) {
  await db.collection(LOCK_COLLECTION).deleteOne({ _id: LOCK_ID, runId });
}

function sameDateValue(a, b) {
  if (a == null || b == null) return a == b;
  return new Date(a).getTime() === new Date(b).getTime();
}

function sameTechnicalValue(field, a, b) {
  if (field === 'fecha_creacion') return sameDateValue(a, b);
  if (field === 'duracion_segundos') return Math.abs(Number(a) - Number(b)) <= 2; // mismo margen que mongo-content-id-preflight-v2.js
  return a === b;
}

// ── Plan de merge para un par (files, backup_files) ya matcheado ───────────
// Implementa reglas 1-9 de la sección 4 del plan. NO ejecuta nada -- devuelve
// qué habría que escribir y en qué bucket cae el documento.
function planMerge({ f, b, matchedBy, filesByContentId, filesByNameKey }) {
  const set = {};
  const notes = { technicalConflicts: [], renameCollision: false, contentIdCollision: false };
  const ambiguousFields = [];

  // Regla 3: content_id ya fijado en `files` gana. Si falta, se completa
  // desde backup -- salvo que otro documento de `files` del mismo usuario ya
  // reclame ese content_id (índice único parcial), en cuyo caso es colisión
  // y NO se setea (rule 4 aplica el mismo criterio de "se reporta y se
  // omite" a cualquier colisión de identidad, no solo al rename).
  if (!f.content_id && b.content_id) {
    const holder = filesByContentId.get(`${f.userId}::${b.content_id}`);
    if (holder && String(holder._id) !== String(f._id)) {
      notes.contentIdCollision = true;
    } else {
      set.content_id = b.content_id;
    }
  }

  // Regla 4: rename solo si el match fue por content_id (si matcheó por
  // file_name, b.file_name === f.file_name por construcción). Colisión con
  // el file_name de OTRO documento del mismo usuario => se reporta y omite.
  if (matchedBy === 'content_id' && b.file_name && b.file_name !== f.file_name) {
    const other = filesByNameKey.get(`${f.userId}::${b.file_name}`);
    if (other && String(other._id) !== String(f._id)) {
      notes.renameCollision = true;
    } else {
      set.file_name = b.file_name;
    }
  }

  // Reglas 5+6: plataformas. `files` es hoy más autoritativo que
  // `backup_files` para esto (ver sección 1) -- si YA tiene algún dato,
  // nunca se toca (ni badges ni platform_states), sin importar timestamps:
  // antes de esta migración `files.platforms_updated_at` no existía para
  // NINGÚN documento histórico, así que nunca hay un reloj comparable de
  // ambos lados para arbitrar un LWW real (regla 6, rama "si falta un
  // reloj, conservar el estado central"). Solo se rellena cuando `files`
  // está completamente vacío de plataformas.
  const fHasPlatforms = (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0) > 0;
  const bHasPlatforms = (b.platforms?.length ?? 0) + (b.platforms_discarded?.length ?? 0) > 0;
  if (!fHasPlatforms && bHasPlatforms) {
    set.platforms = b.platforms ?? [];
    set.platforms_discarded = b.platforms_discarded ?? [];
    if (b.platforms_updated_at) set.platforms_updated_at = b.platforms_updated_at;
  }

  // local_updated_at: reloj general del escritorio, nunca existió en `files`
  // antes de la Entrega A -- se completa directo si falta, sin ambigüedad
  // posible (no hay lado "central" previo con el que comparar).
  if (!f.local_updated_at && b.local_updated_at) set.local_updated_at = b.local_updated_at;

  // Regla 7: tipo_contenido se copia si falta.
  if (!f.tipo_contenido && b.tipo_contenido) set.tipo_contenido = b.tipo_contenido;

  // Regla 8: metadata técnica se rellena si falta; si ambos lados tienen
  // datos y difieren, va al reporte de conflictos (no bloquea, no se pisa).
  for (const field of TECHNICAL_FIELDS) {
    const fv = f[field];
    const bv = b[field];
    if ((fv === undefined || fv === null) && bv !== undefined && bv !== null) {
      set[field] = bv;
    } else if (fv !== undefined && fv !== null && bv !== undefined && bv !== null && !sameTechnicalValue(field, fv, bv)) {
      notes.technicalConflicts.push({ field, files: fv, backup: bv });
    }
  }

  // Regla 9: content_status / scheduled_date divergentes sin reloj
  // comparable => ambiguos. Igual que con platforms, `files` nunca tuvo un
  // reloj dedicado para esto -- toda divergencia real es ambigua por
  // definición en esta migración histórica.
  if (f.content_status != null && b.content_status != null && f.content_status !== b.content_status) {
    ambiguousFields.push({ field: 'content_status', files: f.content_status, backup: b.content_status });
  } else if ((f.content_status === undefined || f.content_status === null) && b.content_status != null) {
    set.content_status = b.content_status;
  }
  if (f.scheduled_date != null && b.scheduled_date != null && !sameDateValue(f.scheduled_date, b.scheduled_date)) {
    ambiguousFields.push({ field: 'scheduled_date', files: f.scheduled_date, backup: b.scheduled_date });
  } else if ((f.scheduled_date === undefined || f.scheduled_date === null) && b.scheduled_date != null) {
    set.scheduled_date = b.scheduled_date;
  }

  // backup_synced_at / backup_source_device_id: semántica nueva de la
  // sección 2, nunca existió antes -- siempre segura de setear.
  // backup_source_device_id se deja null a propósito: backup_files nunca
  // registró qué dispositivo produjo cada push históricamente, y fabricar un
  // valor sería inventar un dato que no existe (se completa solo desde el
  // próximo push real, ver Entrega A).
  set.backup_synced_at = b.updatedAt ?? new Date();

  let bucket = 'safe';
  if (notes.contentIdCollision || notes.renameCollision) bucket = 'collision';
  if (ambiguousFields.length > 0) bucket = 'ambiguous'; // ambiguous pisa a collision -- es el caso más severo

  return { bucket, set, notes, ambiguousFields };
}

function keyFor(userId, contentId, fileName) {
  return contentId ? `cid:${userId}::${contentId}` : `name:${userId}::${fileName}`;
}

async function main() {
  const opts = parseArgs();
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 45).join('\n'));
    return;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI no está seteado');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  console.log('Conectado a MongoDB.');

  const runId = opts.resume || newRunId();
  const isCanary = !!(opts.userId || opts.limit);
  console.log(`runId: ${runId}${opts.resume ? ' (resume)' : ''}`);
  console.log(`Alcance: ${opts.userId ? `userId=${opts.userId}` : 'TODOS los usuarios'}${opts.limit ? `, limit=${opts.limit}` : ''} -- ${isCanary ? 'CANARY' : 'GLOBAL'}`);
  console.log(`Modo: ${opts.apply ? 'APPLY' : 'DRY-RUN'}\n`);

  await acquireLock(db, runId);
  try {
    // ── 1. Cargar backup_files candidatos ────────────────────────────────
    const bQuery = opts.userId ? { userId: opts.userId } : {};
    let backupCursor = db.collection('backup_files').find(bQuery);
    if (opts.limit) backupCursor = backupCursor.limit(opts.limit);
    const backupDocs = await backupCursor.toArray();
    console.log(`backup_files candidatos: ${backupDocs.length}`);

    const userIds = [...new Set(backupDocs.map((b) => b.userId))];
    const filesDocs = userIds.length
      ? await db.collection('files').find({ userId: { $in: userIds } }).toArray()
      : [];
    console.log(`files de esos ${userIds.length} usuario(s): ${filesDocs.length}\n`);

    const filesByContentId = new Map();
    const filesByNameKey = new Map();
    for (const f of filesDocs) {
      if (f.content_id) filesByContentId.set(`${f.userId}::${f.content_id}`, f);
      const nameKey = `${f.userId}::${f.file_name}`;
      // Defensivo: no debería haber duplicados de (userId, file_name) en
      // `files`, pero si los hubiera, más vale no adivinar cuál es el
      // correcto -- se deja fuera del mapa y cualquier backup_files que
      // matchee por nombre a esa clave cae a "sin match" (huérfano).
      if (filesByNameKey.has(nameKey)) filesByNameKey.set(nameKey, null);
      else filesByNameKey.set(nameKey, f);
    }

    // ── 2. Clasificar cada backup_files candidato ────────────────────────
    const buckets = { safe: [], ambiguous: [], collision: [], error: [], orphan: [] };
    for (const b of backupDocs) {
      try {
        let f = null;
        let matchedBy = null;
        if (b.content_id) {
          const viaId = filesByContentId.get(`${b.userId}::${b.content_id}`);
          if (viaId) { f = viaId; matchedBy = 'content_id'; }
        }
        if (!f) {
          const viaName = filesByNameKey.get(`${b.userId}::${b.file_name}`);
          if (viaName) { f = viaName; matchedBy = 'file_name'; }
        }
        if (!f) {
          buckets.orphan.push({ backup_files_id: String(b._id), userId: b.userId, file_name: b.file_name, content_id: b.content_id ?? null });
          continue;
        }

        const { bucket, set, notes, ambiguousFields } = planMerge({ f, b, matchedBy, filesByContentId, filesByNameKey });
        const entry = {
          files_id: String(f._id),
          backup_files_id: String(b._id),
          userId: f.userId,
          matchedBy,
          file_name: f.file_name,
          set,
          notes,
          ambiguousFields,
          observedUpdatedAt: f.updatedAt ?? null, // para el filtro de concurrencia optimista al aplicar
          recommendation: ambiguousFields.length ? 'keep-files' : undefined,
        };
        buckets[bucket].push(entry);
      } catch (err) {
        buckets.error.push({ backup_files_id: String(b._id), userId: b.userId, file_name: b.file_name, reason: err.message });
      }
    }

    console.log('── Clasificación ──');
    console.log(`  safe:      ${buckets.safe.length}`);
    console.log(`  ambiguous: ${buckets.ambiguous.length}`);
    console.log(`  collision: ${buckets.collision.length}`);
    console.log(`  error:     ${buckets.error.length}`);
    console.log(`  orphan:    ${buckets.orphan.length} (informativo -- sin match en 'files', no se toca)\n`);

    writeJson(`preflight-${runId}.json`, {
      runId, generatedAt: new Date().toISOString(), scope: { userId: opts.userId, limit: opts.limit },
      counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    });
    writeNdjson(`ambiguous-${runId}.ndjson`, buckets.ambiguous);
    writeNdjson(`collision-${runId}.ndjson`, buckets.collision);
    writeNdjson(`error-${runId}.ndjson`, buckets.error);
    writeNdjson(`orphan-${runId}.ndjson`, buckets.orphan);
    if (buckets.collision.length) console.log(`⚠ ${buckets.collision.length} colisión(es) -- ver collision-${runId}.ndjson (se aplica el resto del documento, la parte colisionada se omite).`);
    if (buckets.error.length) console.log(`⚠ ${buckets.error.length} error(es) -- ver error-${runId}.ndjson.`);

    // ── 3. Plantilla de resoluciones, si se pidió ────────────────────────
    if (opts.generateTemplate) {
      const template = Object.fromEntries(buckets.ambiguous.map((a) => [
        keyFor(a.userId, null, a.file_name),
        { files_id: a.files_id, ambiguousFields: a.ambiguousFields.map((x) => x.field), decision: 'keep-files', manualValue: undefined },
      ]));
      const p = writeJson(`resolutions-${runId}.json`, template);
      console.log(`\nPlantilla de resoluciones generada en: ${p}`);
      console.log('Editá "decision" por fila (keep-files | take-backup | manual-value) y volvé a correr con --resolutions.');
      return; // el finally de main() libera el lock y desconecta -- no duplicar acá.
    }

    // ── 4. Resolver ambiguos con el archivo de resoluciones (si hay) ─────
    const resolutionsPath = opts.resolutionsPath || (opts.resume ? path.join(OUT_DIR, `resolutions-${runId}.json`) : null);
    let resolutions = {};
    if (resolutionsPath && fs.existsSync(resolutionsPath)) {
      resolutions = JSON.parse(fs.readFileSync(resolutionsPath, 'utf8'));
      console.log(`\nResoluciones cargadas de: ${resolutionsPath} (${Object.keys(resolutions).length} entradas)`);
    } else if (opts.resolutionsPath) {
      throw new Error(`No se encontró el archivo de resoluciones: ${opts.resolutionsPath}`);
    }

    const resolved = [];
    const stillAmbiguous = [];
    for (const a of buckets.ambiguous) {
      const key = keyFor(a.userId, null, a.file_name);
      const res = resolutions[key];
      if (!res || !res.decision) { stillAmbiguous.push(a); continue; }
      const finalSet = { ...a.set };
      for (const { field, backup } of a.ambiguousFields) {
        if (res.decision === 'take-backup') finalSet[field] = backup;
        else if (res.decision === 'manual-value' && res.manualValue && field in res.manualValue) finalSet[field] = res.manualValue[field];
        // 'keep-files': no seteamos el campo -- se conserva el valor actual de `files` tal cual.
      }
      resolved.push({ ...a, set: finalSet, resolvedVia: res.decision });
    }
    if (resolved.length) {
      writeNdjson(`resolved-${runId}.ndjson`, resolved);
      console.log(`Ambiguos resueltos por el archivo de resoluciones: ${resolved.length}`);
    }
    if (stillAmbiguous.length) console.log(`Ambiguos SIN resolución todavía: ${stillAmbiguous.length}`);

    const toApply = [...buckets.safe, ...buckets.collision, ...resolved];

    if (!opts.apply) {
      console.log(`\n=== DRY-RUN (pasá --apply para escribir) ===`);
      console.log(`Se actualizarían ${toApply.length} documentos de 'files'.`);
      return; // el finally de main() libera el lock y desconecta -- no duplicar acá.
    }

    // ── 5. Gate: el apply GLOBAL exige cero ambiguos sin resolver ────────
    if (!isCanary && stillAmbiguous.length > 0) {
      throw new Error(
        `Apply GLOBAL rechazado: ${stillAmbiguous.length} documento(s) ambiguo(s) sin resolución. ` +
        `Un canary (--user-id/--limit) puede avanzar con ambiguos pendientes; el apply global no.`,
      );
    }

    // ── 6. Snapshot COMPLETO de backup_files -- obligatorio antes de aplicar ──
    console.log('\nTomando snapshot completo de backup_files (obligatorio antes de --apply)...');
    const snapshotPath = path.join(OUT_DIR, `backup_files-full-snapshot-${runId}.ndjson`);
    ensureOutDir();
    const snapshotStream = fs.createWriteStream(snapshotPath);
    let snapshotCount = 0;
    const fullCursor = db.collection('backup_files').find({});
    for await (const doc of fullCursor) {
      snapshotStream.write(JSON.stringify(doc) + '\n');
      snapshotCount++;
    }
    await new Promise((resolve, reject) => snapshotStream.end((err) => (err ? reject(err) : resolve())));
    console.log(`Snapshot completo: ${snapshotCount} documentos -> ${snapshotPath}`);

    // ── 7. Snapshot "antes" de los documentos de `files` que se van a tocar ──
    const beforeSnapshot = toApply.map((entry) => {
      const original = filesDocs.find((f) => String(f._id) === entry.files_id);
      return { files_id: entry.files_id, before: original ?? null };
    });
    const beforePath = writeJson(`before-${runId}.json`, beforeSnapshot);
    console.log(`Snapshot "antes" de ${beforeSnapshot.length} documentos de files -> ${beforePath}`);

    // ── 8. Aplicar, con concurrencia optimista por documento ─────────────
    console.log(`\n=== APLICANDO ${toApply.length} actualizaciones ===\n`);
    const applied = [];
    const concurrentChanges = [];
    const applyErrors = [];
    for (const entry of toApply) {
      try {
        const filter = { _id: new mongoose.Types.ObjectId(entry.files_id) };
        // Concurrencia optimista (sección "Concurrencia y reentrada"): solo
        // condiciona por updatedAt si lo observamos en el preflight -- un
        // documento sin updatedAt (no debería pasar con timestamps:true,
        // pero por si acaso) se aplica sin esa condición extra.
        if (entry.observedUpdatedAt) filter.updatedAt = new Date(entry.observedUpdatedAt);
        const result = await db.collection('files').updateOne(filter, { $set: entry.set });
        if (result.matchedCount === 0) {
          concurrentChanges.push({ ...entry, reason: 'updatedAt cambió entre el preflight y el apply -- no se pisó el push que ganó la carrera.' });
        } else {
          applied.push({ files_id: entry.files_id, modified: result.modifiedCount === 1 });
        }
      } catch (err) {
        applyErrors.push({ files_id: entry.files_id, backup_files_id: entry.backup_files_id, reason: err.message });
      }
    }
    console.log(`Aplicados: ${applied.length} (${applied.filter((a) => a.modified).length} modificados, ${applied.filter((a) => !a.modified).length} ya coincidían -- no-op de una corrida repetida)`);
    console.log(`Concurrent_change (no pisados): ${concurrentChanges.length}`);
    console.log(`Errores de escritura: ${applyErrors.length}`);
    if (concurrentChanges.length) writeNdjson(`concurrent-change-${runId}.ndjson`, concurrentChanges);
    if (applyErrors.length) writeNdjson(`apply-errors-${runId}.ndjson`, applyErrors);
    writeNdjson(`applied-${runId}.ndjson`, applied);

    // ── 9. Postflight ─────────────────────────────────────────────────────
    const appliedIds = applied.map((a) => new mongoose.Types.ObjectId(a.files_id));
    const postDocs = appliedIds.length
      ? await db.collection('files').find({ _id: { $in: appliedIds } }).toArray()
      : [];
    console.log(`\n=== POSTFLIGHT ===`);
    console.log(`Documentos re-leídos: ${postDocs.length} de ${appliedIds.length} esperados.`);
    if (postDocs.length !== appliedIds.length) {
      console.log('⚠ El postflight difiere del número de updates reconocido por MongoDB -- revisar antes de dar por cerrado (condición de aborto de la sección 7).');
    }
    let missingBackupSyncedAt = 0;
    for (const d of postDocs) if (!d.backup_synced_at) missingBackupSyncedAt++;
    console.log(missingBackupSyncedAt === 0
      ? '✓ Todos los documentos aplicados tienen backup_synced_at.'
      : `⚠ ${missingBackupSyncedAt} documento(s) aplicados sin backup_synced_at -- inesperado, revisar.`);

    // ── 10. Script de rollback, generado del snapshot "antes" ────────────
    const rollbackDocs = beforeSnapshot.filter((b) => b.before && applied.some((a) => a.files_id === b.files_id));
    const rollbackPath = path.join(OUT_DIR, `rollback-${runId}.js`);
    const rollbackScript = `#!/usr/bin/env node
// Rollback generado automáticamente por mongo-files-consolidation.js el
// ${new Date().toISOString()} (runId=${runId}). Restaura los documentos de
// 'files' tocados por esa corrida a su estado previo exacto. NO toca
// backup_files (esta migración nunca la modificó). Dry-run por default,
// --apply para escribir.
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const docs = ${JSON.stringify(rollbackDocs, null, 2)};
async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(\`\${apply ? 'Restaurando' : 'DRY-RUN, restauraría'} \${docs.length} documentos de files a su estado previo a runId=${runId}...\`);
  if (apply) {
    for (const d of docs) {
      await db.collection('files').replaceOne({ _id: new mongoose.Types.ObjectId(d.files_id) }, d.before);
    }
    console.log('Rollback aplicado.');
  }
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
`;
    fs.writeFileSync(rollbackPath, rollbackScript);
    console.log(`\nScript de rollback generado en: ${rollbackPath}`);
  } finally {
    await releaseLock(db, runId);
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
