// Harness de convergencia de sincronización — Entrega 1 del plan de
// docs/sync-reconciliation-map-2026-09-08.md.
//
// Tests de contrato por tramo. El del ciclo completo vive en backend/ (ver
// sync-integral.test.ts). Acá se prueba contra el código de producción REAL
// reglas: se importa y se ejecuta `setPlatformLink` y `pullFromCloud` tal como
// corren en la app). Se ponen en verde con la Entrega 1, no antes.
//
// Alcance deliberado: ninguno de los dos necesita Mongo. Cubren los dos
// extremos donde el daño es observable y donde la Entrega 1 va a intervenir:
//   - Test 1: el contrato que sale de Electron (id local vs. ObjectId central).
//   - Test 2: el pull, que es donde el descarte revertido aterriza en SQLite.
// El tramo central (bulkUpsertBackupFiles re-agregando la plataforma por la
// protección de BUG-2026-09-06-04) queda fuera: exige un Mongo descartable,
// que es una decisión de tooling aparte. Está descrito en el informe.
//
// Correr:  cd local-backend && npx tsx --test src/controllers/sync-convergence.test.ts

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// database.ts resuelve DB_PATH al cargar el módulo, así que la env var tiene
// que estar puesta ANTES del primer import del repo -- por eso todos los
// imports de src/ de acá abajo son dinámicos, dentro de los tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esse-sync-convergence-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'convergencia.db');
// El wrapper de métricas hace un round-trip extra del body cuando está activo;
// no aporta nada acá y ensucia la salida del test.
delete process.env.ESSE_SYNC_METRICS;

const AUTH = 'Bearer token-de-prueba';

// `db` es un singleton del módulo, compartido por todos los tests del archivo.
// Cerrarlo dentro de un test rompe a los siguientes -- y peor: rompe con
// "The database connection is not open", que se lee igual que un fallo del
// código bajo prueba. Pasó de verdad: mientras el primer test estaba rojo
// fallaba ANTES de su `db.close()`, así que el segundo corría bien; al arreglar
// el bug 1, el primero empezó a llegar al close y el segundo pasó a fallar por
// infraestructura disfrazada de bug. Se cierra una sola vez, al final.
after(async () => {
  const { db } = await import('../db/database');
  if (db.open) db.close();
});

/** Respuesta JSON mínima, del shape que devuelve la central. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Reemplaza `globalThis.fetch` y registra cada URL pedida. `routes` mapea un
 * fragmento de URL al body que debe devolverse; lo no mapeado devuelve `{}`
 * (los pulls secundarios -- config, platform-videos -- no son el objeto de
 * estos tests, solo no deben romper el flujo).
 */
interface LlamadaStub { url: string; body: any }

function stubFetch(routes: Record<string, unknown>): {
  calls: string[]; llamadas: LlamadaStub[]; restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const llamadas: LlamadaStub[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push(url);
    let body: any = undefined;
    try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { /* no era JSON */ }
    llamadas.push({ url, body });
    const hit = Object.keys(routes).find(fragment => url.includes(fragment));
    return jsonResponse(hit ? routes[hit] : {});
  }) as typeof fetch;
  return { calls, llamadas, restore: () => { globalThis.fetch = original; } };
}

/** Par req/res falso, suficiente para los handlers de Express que se prueban. */
function fakeReqRes(params: Record<string, string>, body: unknown = {}) {
  const req: any = { params, body, headers: { authorization: AUTH }, query: {} };
  const captured: { status: number; payload: unknown } = { status: 200, payload: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.payload = payload; return res; },
  };
  return { req, res, captured };
}

// ---------------------------------------------------------------------------
// BUG 1 — Desvincular desde Electron nunca llegó a la central.
//
// `setPlatformLink` con url vacía limpia el link local y avisa a la central vía
// `reportUnlinkPlatform`. Antes armaba el DELETE con el id de SQLite (un entero
// autoincremental) y del otro lado `unlinkPlatform` lo usaba como filtro `_id`
// de Mongo, que espera un ObjectId: el cast fallaba, respondía 500 y el
// local-backend se lo tragaba con un console.warn. Nunca funcionó.
//
// La expectativa de este test CAMBIÓ DOS VECES junto con el plan, sin que lo
// que afirma cambie nunca ("Electron tiene que mandar un identificador que la
// central pueda resolver"):
//
//  1. La clave de mutación pasó a ser `content_id` (UUID), no un
//     `remote_file_id` nuevo -- medido contra producción, el 100% de los
//     archivos activos de los dos lados ya lo tiene, con índice único.
//  2. El transporte pasó del `DELETE /api/sync/platform-link/:contentId/...` a
//     `POST /api/sync/platform-transition`, porque la desvinculación ahora sale
//     por la outbox y necesita declarar `operationId` (deduplicar el reintento)
//     y `baseVersion` (precedencia causal) -- cosas que una URL de DELETE no
//     puede expresar. El identificador dejó de viajar en el path y viaja en el
//     cuerpo, así que se lee de ahí.
//
// Ver docs/sync-convergence-plan-2026-09-08.md.
// ---------------------------------------------------------------------------
test('BUG 1 — al desvincular, Electron manda a la central un identificador que puede resolver', async () => {
  const { db } = await import('../db/database');
  const { fileRepo } = await import('../db/file.repo');
  const { platformVideoRepo } = await import('../db/platform-video.repo');
  const { setPlatformLink } = await import('./video.controller');

  // `fileRepo.create` genera el content_id él mismo (randomUUID, siempre) y no
  // acepta uno de afuera -- así que se lee el que quedó, en vez de asumir uno.
  const file = fileRepo.create({
    file_name: 'video para desvincular.mp4',
    file_path: 'C:/videos/video para desvincular.mp4',
  });
  const CONTENT_ID = file.content_id!;

  platformVideoRepo.upsert({
    platform: 'instagram',
    platform_id: '17999999999999999',
    platform_url: 'https://www.instagram.com/reel/AAAAAAAAAAA/',
    linked_file_id: file.id,
    match_status: 'manual',
  });
  fileRepo.addPlatform(file.id, 'instagram');

  const stub = stubFetch({});
  try {
    // url vacía = "borrar el link de esta plataforma" (ver setPlatformLink).
    const { req, res } = fakeReqRes({ fileId: String(file.id), platform: 'instagram' }, { url: '' });
    await setPlatformLink(req, res);
  } finally {
    stub.restore();
  }

  const unlinkCall = stub.llamadas.find(l => l.url.includes('/api/sync/platform-transition'));
  assert.ok(unlinkCall, 'Electron debería avisarle a la central que se desvinculó la plataforma');

  // El identificador que la central va a usar para resolver el archivo.
  const sentId = String(unlinkCall.body?.contentId ?? '');

  assert.match(
    sentId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    `La central resuelve el archivo por content_id (UUID). Se recibió "${sentId}" -- si es un ` +
    `número, es el id de SQLite y la central no tiene forma de resolverlo.`,
  );
  assert.equal(sentId, CONTENT_ID, 'y tiene que ser el content_id de ESE archivo, no otro');
  assert.equal(unlinkCall.body?.platform, 'instagram');
  assert.equal(unlinkCall.body?.action, 'unlink');

  // Sin estos dos el endpoint responde 400: son lo que distingue una intención
  // reintentable de un disparo a ciegas.
  assert.ok(unlinkCall.body?.operationId, 'sin operationId la central no puede deduplicar el reintento');
  assert.ok(Number.isInteger(unlinkCall.body?.baseVersion) && unlinkCall.body.baseVersion >= 0,
    'sin baseVersion la central no puede saber sobre qué estado se decidió');

});

// El test del pull que estaba acá se retiró a propósito: hardcodeaba la
// respuesta DEFECTUOSA de la central, así que habría seguido rojo aunque el bug
// se arreglara -- probaba la reproducción del incidente, no el contrato. Lo
// reemplaza backend/src/controllers/sync-integral.test.ts, que corre el ciclo
// push/pull real contra los controladores de la central. Ver el paso 5 de
// docs/sync-convergence-plan-2026-09-08.md.
