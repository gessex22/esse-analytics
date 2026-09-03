/**
 * backup-canonical-contract-check.ts
 *
 * Gate de la Entrega A (docs/mongo-collections-consolidation-plan-2026-09-02.md
 * §5): compara, para un usuario, la salida del camino VIEJO de los 3 GET de
 * /api/backup (merge FileModel+BackupFileModel en backup.controller.ts)
 * contra el camino CANÓNICO (backup-file-canonical.service.ts, solo `files`).
 *
 * Es de SOLO LECTURA -- no escribe nada en ninguna colección ni activa
 * BACKUP_CANONICAL_READS en ningún backend real, solo llama a las mismas
 * funciones/queries que usaría ese flag.
 *
 * Uso:
 *   cd backend
 *   npx tsx src/scripts/backup-canonical-contract-check.ts [--user <userId>]
 *
 * Sin --user, usa el userId del OWNER_USERNAME (env, default 'esse').
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { UserModel } from '../models/user.model';
import { BackupFileModel } from '../models/backup-file.model';
import { FileModel } from '../models/file.model';
import {
  getCanonicalBackupFiles,
  getCanonicalBackupStatus,
  getCanonicalSyncStatusBackedUpSet,
} from '../services/backup-file-canonical.service';

dotenv.config();

const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'esse').toLowerCase();

// Réplica de solo lectura del merge de GET /api/backup/files (getBackupFiles
// en backup.controller.ts) -- deliberadamente duplicada acá en vez de
// importada, porque ese controller no exporta la lógica de merge como
// función independiente y este script no debe requerir un refactor previo
// para poder correr. Si el controller cambia, este script puede desactualizarse
// -- es un gate de una migración puntual, no un test permanente.
async function legacyBackupFiles(userId: string, includeResolved: boolean) {
  const [allFiles, user, centralFiles] = await Promise.all([
    BackupFileModel.find({ userId }).lean(),
    UserModel.findById(userId, { video_folder: 1 }).lean(),
    FileModel.find({ userId }).select('file_name platforms platforms_discarded platform_states content_status scheduled_date duracion_segundos resolucion formato fecha_creacion updatedAt').lean(),
  ]);
  const centralByName = new Map(centralFiles.map(f => [f.file_name, f]));
  const backupNames = new Set(allFiles.map(f => f.file_name));
  const enriched = allFiles.map(f => {
    const current = (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0);
    const central = centralByName.get(f.file_name);
    const platform_states = central?.platform_states ?? (f as any).platform_states;
    if (current >= 3) return { ...f, platform_states };
    if (!central) return { ...f, platform_states };
    const centralPlatforms = [...(central.platforms ?? [])].sort().join('|');
    const currentPlatforms = [...(f.platforms ?? [])].sort().join('|');
    const centralDiscarded = [...(central.platforms_discarded ?? [])].sort().join('|');
    const currentDiscarded = [...(f.platforms_discarded ?? [])].sort().join('|');
    if (centralPlatforms === currentPlatforms && centralDiscarded === currentDiscarded) {
      return { ...f, platform_states };
    }
    return {
      ...f,
      platforms: central.platforms ?? f.platforms,
      platforms_discarded: central.platforms_discarded ?? f.platforms_discarded,
      platform_states,
      local_updated_at: (central as any).updatedAt ?? f.local_updated_at,
    };
  });
  const onlyInCentral = centralFiles
    .filter(f => !backupNames.has(f.file_name))
    .map(f => ({
      _id: f._id,
      createdAt: f.fecha_creacion ?? (f as any).updatedAt ?? new Date(),
      file_name: f.file_name,
      platforms: f.platforms ?? [],
      platforms_discarded: f.platforms_discarded ?? [],
      platform_states: f.platform_states ?? [],
      content_status: f.content_status ?? 'borrador',
      scheduled_date: f.scheduled_date ?? null,
      duracion_segundos: f.duracion_segundos ?? null,
      resolucion: f.resolucion ?? null,
      formato: f.formato ?? null,
      fecha_creacion: f.fecha_creacion ?? null,
      local_updated_at: (f as any).updatedAt,
      platforms_updated_at: null as Date | null,
    }));
  const merged = [...enriched, ...onlyInCentral];
  const files = includeResolved
    ? merged
    : merged.filter(f => (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0) < 3);
  return { files, video_folder: user?.video_folder ?? null };
}

function platformsKey(platforms: string[] = [], discarded: string[] = []) {
  return `${[...platforms].sort().join(',')}|${[...discarded].sort().join(',')}`;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 });
  console.log('Conectado a MongoDB (solo lectura)');

  const uidArgIdx = process.argv.indexOf('--user');
  let userId: string;
  if (uidArgIdx !== -1 && process.argv[uidArgIdx + 1]) {
    userId = process.argv[uidArgIdx + 1];
  } else {
    const user = await UserModel.findOne({ username: OWNER_USERNAME }).lean();
    if (!user) { console.error(`Usuario '${OWNER_USERNAME}' no encontrado. Usa --user <id>`); process.exit(1); }
    userId = String(user!._id);
  }
  console.log(`userId: ${userId}\n`);

  let mismatches = 0;

  for (const includeResolved of [false, true]) {
    console.log(`── GET /api/backup/files?includeResolved=${includeResolved} ──`);
    const [legacy, canonical] = await Promise.all([
      legacyBackupFiles(userId, includeResolved),
      getCanonicalBackupFiles(userId, includeResolved),
    ]);
    console.log(`  legacy: ${legacy.files.length} archivos | canonical: ${canonical.files.length} archivos`);

    const legacyByName = new Map(legacy.files.map(f => [f.file_name, f]));
    const canonicalByName = new Map(canonical.files.map(f => [f.file_name, f]));

    const onlyLegacy = [...legacyByName.keys()].filter(n => !canonicalByName.has(n));
    const onlyCanonical = [...canonicalByName.keys()].filter(n => !legacyByName.has(n));
    if (onlyLegacy.length) { mismatches += onlyLegacy.length; console.log(`  ⚠ solo en legacy (${onlyLegacy.length}): ${onlyLegacy.slice(0, 5).join(', ')}${onlyLegacy.length > 5 ? '…' : ''}`); }
    if (onlyCanonical.length) { mismatches += onlyCanonical.length; console.log(`  ⚠ solo en canonical (${onlyCanonical.length}): ${onlyCanonical.slice(0, 5).join(', ')}${onlyCanonical.length > 5 ? '…' : ''}`); }

    let platformDiffs = 0;
    for (const [name, l] of legacyByName) {
      const c = canonicalByName.get(name);
      if (!c) continue;
      if (platformsKey(l.platforms, l.platforms_discarded) !== platformsKey(c.platforms, c.platforms_discarded)) {
        platformDiffs++;
        if (platformDiffs <= 5) console.log(`  ⚠ platforms distintos en "${name}": legacy=${platformsKey(l.platforms, l.platforms_discarded)} canonical=${platformsKey(c.platforms, c.platforms_discarded)}`);
      }
    }
    if (platformDiffs > 5) console.log(`  … y ${platformDiffs - 5} diferencias de platforms más`);
    mismatches += platformDiffs;
    if (!onlyLegacy.length && !onlyCanonical.length && !platformDiffs) console.log('  ✓ sin diferencias');
    console.log('');
  }

  console.log('── GET /api/backup/status ──');
  const [legacyTotal, legacyLatest, canonicalStatus] = await Promise.all([
    BackupFileModel.countDocuments({ userId }),
    BackupFileModel.findOne({ userId }, { updatedAt: 1 }).sort({ updatedAt: -1 }).lean(),
    getCanonicalBackupStatus(userId),
  ]);
  console.log(`  legacy: total=${legacyTotal} lastSync=${(legacyLatest as any)?.updatedAt ?? null}`);
  console.log(`  canonical: total=${canonicalStatus.total} lastSync=${canonicalStatus.lastSync}`);
  console.log(canonicalStatus.total === 0
    ? '  ⚠ canonical.total=0 esperado hasta que corra un push con este código (backup_synced_at recién se completa desde ahora)'
    : '  (comparar manualmente -- total puede diferir mientras backup_synced_at se completa gradualmente con cada push)');
  console.log('');

  console.log('── GET /api/backup/sync-status ──');
  const sample = await FileModel.find({ userId, content_id: { $type: 'string' } }, { content_id: 1 }).limit(20).lean();
  const contentIds = sample.map(f => f.content_id!).filter(Boolean);
  if (contentIds.length === 0) {
    console.log('  (sin content_id de muestra para este usuario, se omite)');
  } else {
    const [legacyBackedUp, canonicalBackedUp] = await Promise.all([
      BackupFileModel.find({ userId, content_id: { $in: contentIds } }, { content_id: 1 }).lean().then(rows => new Set(rows.map(f => f.content_id))),
      getCanonicalSyncStatusBackedUpSet(userId, contentIds),
    ]);
    const onlyLegacy = contentIds.filter(id => legacyBackedUp.has(id) && !canonicalBackedUp.has(id));
    const onlyCanonical = contentIds.filter(id => !legacyBackedUp.has(id) && canonicalBackedUp.has(id));
    console.log(`  ${contentIds.length} content_id de muestra | legacy backedUp=${legacyBackedUp.size} canonical backedUp=${canonicalBackedUp.size}`);
    if (onlyLegacy.length) console.log(`  ⚠ solo respaldado en legacy: ${onlyLegacy.length} (esperado hasta que backup_synced_at se complete con nuevos pushes)`);
    if (onlyCanonical.length) console.log(`  ⚠ solo respaldado en canonical: ${onlyCanonical.length}`);
  }

  console.log(`\n${mismatches === 0 ? '✓' : '⚠'} GET /api/backup/files: ${mismatches} diferencia(s) encontradas (status/sync-status arriba, comparar a mano -- dependen de backup_synced_at, que recién empieza a poblarse).`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
