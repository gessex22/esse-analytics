// Comparador canary de la Entrega C
// (docs/mongo-collections-consolidation-plan-2026-09-02.md §5). Compara, para
// una allowlist chica de usuarios, la respuesta LEGACY (BackupFileModel +
// FileModel mergeados a mano en backup.controller.ts) contra la CANÓNICA
// (backup-file-canonical.service.ts, Entrega A) -- sin cambiar qué recibe el
// cliente: el legacy sigue siendo lo único que se responde, esto corre
// después de `res.json(...)`, best-effort, y nunca debe poder tumbar ni
// demorar una request real.
//
// Límites duros, todos del plan (no ajustables por env a propósito -- son
// parte del diseño de la Entrega C, no un parámetro operativo):
// - 1 comparación concurrente como máximo (todo el proceso, no por usuario).
// - cooldown de 15 min por usuario.
// - se apaga sola a los 200 pares válidos o 24h desde el primer par,
//   lo que pase primero.
// Estado persistido en Mongo (no en memoria) para sobrevivir un restart del
// backend -- sin esto, un redeploy en medio de la ventana reiniciaría el
// contador y podría extender la comparación mucho más de lo previsto.
import mongoose from 'mongoose';
import { getCanonicalBackupFiles, CanonicalBackupFileDto } from './backup-file-canonical.service';

const STATE_COLLECTION = 'backup_canary_comparison_state';
const RESULTS_COLLECTION = 'backup_canary_comparison_results';
const STATE_ID = 'backup-files-entrega-c';

const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_PAIRS = 200;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

// Allowlist canary -- vacía por default (sin CANARY_USER_IDS, esto es un
// no-op total, ni siquiera pega a Mongo). Lista separada por comas de
// userIds, no de usernames -- mismo criterio que OWNER_USERNAME de
// auth.middleware.ts pero acá son varios y por id, no por nombre.
function canaryAllowlist(): Set<string> {
  const raw = process.env.CANARY_USER_IDS || '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

// Concurrencia = 1 para todo el proceso -- un solo backend central corre a
// la vez (detrás de Cloudflare Tunnel), así que un booleano en memoria
// alcanza; no hace falta un lock distribuido como el de la Entrega B.
let comparisonInFlight = false;

interface LegacyFileForCompare {
  file_name: string;
  platforms?: string[];
  platforms_discarded?: string[];
  content_status?: string;
}

interface FieldDiff {
  file_name: string;
  field: string;
  legacy: unknown;
  canonical: unknown;
}

interface ComparisonResult {
  legacyCount: number;
  canonicalCount: number;
  onlyLegacy: string[];
  onlyCanonical: string[];
  fieldDiffs: FieldDiff[];
}

function sortedKey(arr: string[] | undefined): string {
  return [...(arr ?? [])].sort().join(',');
}

// Compara dos listas ya resueltas (mismo shape que el array `files` que
// devuelve GET /api/backup/files) -- normaliza orden de arrays antes de
// comparar, como pide el plan. Solo compara los campos que de verdad
// importan para el contrato (platforms/platforms_discarded/content_status);
// diferencias en metadata técnica ya se cubrieron aparte en el
// contract-check de la Entrega A y no vuelven a compararse acá.
function diffResults(legacy: LegacyFileForCompare[], canonical: CanonicalBackupFileDto[]): ComparisonResult {
  const legacyByName = new Map(legacy.map((f) => [f.file_name, f]));
  const canonicalByName = new Map(canonical.map((f) => [f.file_name, f]));

  const onlyLegacy = [...legacyByName.keys()].filter((n) => !canonicalByName.has(n));
  const onlyCanonical = [...canonicalByName.keys()].filter((n) => !legacyByName.has(n));

  const fieldDiffs: FieldDiff[] = [];
  for (const [name, l] of legacyByName) {
    const c = canonicalByName.get(name);
    if (!c) continue;
    if (sortedKey(l.platforms) !== sortedKey(c.platforms)) {
      fieldDiffs.push({ file_name: name, field: 'platforms', legacy: sortedKey(l.platforms), canonical: sortedKey(c.platforms) });
    }
    if (sortedKey(l.platforms_discarded) !== sortedKey(c.platforms_discarded)) {
      fieldDiffs.push({ file_name: name, field: 'platforms_discarded', legacy: sortedKey(l.platforms_discarded), canonical: sortedKey(c.platforms_discarded) });
    }
    if ((l.content_status ?? null) !== (c.content_status ?? null)) {
      fieldDiffs.push({ file_name: name, field: 'content_status', legacy: l.content_status ?? null, canonical: c.content_status ?? null });
    }
  }

  return { legacyCount: legacy.length, canonicalCount: canonical.length, onlyLegacy, onlyCanonical, fieldDiffs };
}

interface CanaryState {
  _id: string;
  startedAt: Date;
  pairsCompleted: number;
  stopped: boolean;
  stopReason: string | null;
  lastComparedAt: Record<string, string>; // userId -> ISO date, mapa chico (allowlist es chica a propósito)
}

async function loadOrCreateState(): Promise<CanaryState> {
  const col = mongoose.connection.db!.collection<CanaryState>(STATE_COLLECTION);
  const existing = await col.findOne({ _id: STATE_ID } as any);
  if (existing) return existing as unknown as CanaryState;
  const fresh: CanaryState = { _id: STATE_ID, startedAt: new Date(), pairsCompleted: 0, stopped: false, stopReason: null, lastComparedAt: {} };
  await col.insertOne(fresh as any);
  return fresh;
}

// Llamar SIEMPRE fire-and-forget (sin await) después de responder al
// cliente -- getBackupFiles ya manda `.catch(() => {})` sobre esto, pero
// además cada rama interna atrapa sus propios errores para no depender de
// que el caller lo haga bien.
export async function maybeCompareCanary(userId: string, includeResolved: boolean, legacyFiles: LegacyFileForCompare[]): Promise<void> {
  const allowlist = canaryAllowlist();
  if (allowlist.size === 0 || !allowlist.has(userId)) return;
  if (comparisonInFlight) return; // concurrencia = 1: se salta esta vez, no hace cola

  comparisonInFlight = true;
  try {
    const state = await loadOrCreateState();
    if (state.stopped) return;

    const ageMs = Date.now() - new Date(state.startedAt).getTime();
    if (ageMs >= MAX_DURATION_MS) {
      await stopComparator('24h-elapsed');
      return;
    }
    if (state.pairsCompleted >= MAX_PAIRS) {
      await stopComparator('200-pairs-reached');
      return;
    }
    const lastForUser = state.lastComparedAt[userId] ? new Date(state.lastComparedAt[userId]).getTime() : 0;
    if (Date.now() - lastForUser < COOLDOWN_MS) return; // cooldown de 15 min por usuario

    const { files: canonicalFiles } = await getCanonicalBackupFiles(userId, includeResolved);
    const diff = diffResults(legacyFiles, canonicalFiles);
    const hasDiff = diff.onlyLegacy.length > 0 || diff.onlyCanonical.length > 0 || diff.fieldDiffs.length > 0;

    const db = mongoose.connection.db!;
    await db.collection(RESULTS_COLLECTION).insertOne({
      userId, includeResolved, comparedAt: new Date(), hasDiff, ...diff,
    });
    await db.collection(STATE_COLLECTION).updateOne(
      { _id: STATE_ID } as any,
      { $inc: { pairsCompleted: 1 }, $set: { [`lastComparedAt.${userId}`]: new Date().toISOString() } },
    );
    console.log(`[canary-comparison] userId=${userId} includeResolved=${includeResolved} legacy=${diff.legacyCount} canonical=${diff.canonicalCount} diff=${hasDiff ? 'SÍ ⚠' : 'no'} pares=${state.pairsCompleted + 1}/${MAX_PAIRS}`);
  } catch (err: any) {
    console.warn('[canary-comparison] best-effort, error ignorado:', err.message);
  } finally {
    comparisonInFlight = false;
  }
}

async function stopComparator(reason: string): Promise<void> {
  const db = mongoose.connection.db!;
  await db.collection(STATE_COLLECTION).updateOne({ _id: STATE_ID } as any, { $set: { stopped: true, stopReason: reason } });
  console.log(`[canary-comparison] detenido automáticamente: ${reason}. Ver ${RESULTS_COLLECTION} para revisar los pares.`);
}
