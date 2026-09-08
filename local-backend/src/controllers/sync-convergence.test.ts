// Harness de convergencia de sincronización — Entrega 1 del plan de
// docs/sync-reconciliation-map-2026-09-08.md.
//
// ESTOS DOS TESTS ESTÁN EN ROJO A PROPÓSITO. Documentan los bugs 1 y 2 del
// informe contra el código de producción REAL (no una reimplementación de las
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
import { test } from 'node:test';
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
function stubFetch(routes: Record<string, unknown>): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push(url);
    const hit = Object.keys(routes).find(fragment => url.includes(fragment));
    return jsonResponse(hit ? routes[hit] : {});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
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
// La expectativa de este test CAMBIÓ junto con el plan: la clave de mutación
// pasó a ser `content_id` (UUID), no un `remote_file_id` nuevo -- medido contra
// producción, el 100% de los archivos activos de los dos lados ya lo tiene, con
// índice único. Lo que se afirma sigue siendo lo mismo ("Electron tiene que
// mandar un identificador que la central pueda resolver"); solo cambió cuál es
// ese identificador. Ver docs/sync-convergence-plan-2026-09-08.md.
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

  const unlinkCall = stub.calls.find(url => url.includes('/api/sync/platform-link/'));
  assert.ok(unlinkCall, 'Electron debería avisarle a la central que se desvinculó la plataforma');

  // El segmento de path que la central va a usar para resolver el archivo.
  const sentId = decodeURIComponent(new URL(unlinkCall).pathname.split('/').at(-2) ?? '');

  assert.match(
    sentId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    `La central resuelve el archivo por content_id (UUID). Se recibió "${sentId}" -- si es un ` +
    `número, es el id de SQLite y la central no tiene forma de resolverlo.`,
  );
  assert.equal(sentId, CONTENT_ID, 'y tiene que ser el content_id de ESE archivo, no otro');

  db.close();
});

// ---------------------------------------------------------------------------
// BUG 2 — Un descarte hecho en Electron sobre una plataforma `confirmed` se
// revierte solo en el siguiente ciclo.
//
// Este test cubre el ÚLTIMO tramo de la cadena, que es donde el daño se ve: el
// pull. Estado de partida = el que deja el push (`bulkUpsertBackupFiles` re-agrega
// la plataforma por la protección de BUG-2026-09-06-04, que no distingue una
// acción explícita del usuario de un push automático atrasado).
//
// La clave está en el empate de timestamps: la nube devuelve el `platforms` de
// `files` pero el `platforms_updated_at` que la propia PC acaba de pushear. Como
// `localPlatformsWins` exige `>` estricto (backup-sync.controller.ts), el empate
// se resuelve a favor de la nube y el descarte vuelve para atrás.
//
// Se pone en verde cuando la Entrega 1 haga que un descarte explícito sea una
// transición del servicio central (y no un badge que el push pueda reinterpretar).
// ---------------------------------------------------------------------------
test('BUG 2 (rojo) — un descarte explícito local sobrevive al pull cuando los timestamps empatan', async () => {
  const { db } = await import('../db/database');
  const { fileRepo } = await import('../db/file.repo');
  const { pullFromCloud } = await import('./backup-sync.controller');

  const CONTENT_ID = 'contenido-descarte-1';
  const FILE_NAME = 'video descartado a mano.mp4';

  // Mismo instante en los dos lados: es exactamente lo que pasa en producción
  // (la nube devuelve el timestamp que esta misma PC acaba de pushear). Se usa
  // un ISO con Z en los dos para que el test aísle la regla de desempate y no
  // dependa de la zona horaria de la máquina que lo corre.
  const MISMO_INSTANTE = '2026-09-08T12:00:00.000Z';

  const file = fileRepo.create({
    file_name: FILE_NAME,
    file_path: `C:/videos/${FILE_NAME}`,
    content_id: CONTENT_ID,
  } as any);

  // El usuario descartó Instagram en Electron: sin badge y en descartados.
  db.prepare(`
    UPDATE files
       SET platforms = '[]',
           platforms_discarded = '["instagram"]',
           platforms_updated_at = ?,
           updated_at = ?
     WHERE id = ?
  `).run(MISMO_INSTANTE, MISMO_INSTANTE, file.id);

  // Lo que la central devuelve DESPUÉS del push: Instagram volvió a `platforms`
  // (la protección de `confirmed` la re-agregó) y el descarte se perdió.
  const respuestaDeLaCentral = {
    files: [{
      content_id: CONTENT_ID,
      file_name: FILE_NAME,
      platforms: ['instagram'],
      platforms_discarded: [],
      platforms_updated_at: MISMO_INSTANTE,
      local_updated_at: MISMO_INSTANTE,
      content_status: 'borrador',
      duracion_segundos: null,
    }],
  };

  const stub = stubFetch({
    '/api/backup/files': respuestaDeLaCentral,
    '/api/backup/platform-videos': { videos: [] },
    '/api/backup/config': { workflow_mode: null, platform_configs: [] },
  });
  try {
    const { req, res } = fakeReqRes({});
    await pullFromCloud(req, res);
  } finally {
    stub.restore();
  }

  const despues = fileRepo.findById(file.id)!;

  assert.deepEqual(
    despues.platforms_discarded, ['instagram'],
    'El descarte explícito del usuario debe seguir en pie después del pull. Hoy no: la nube ' +
    'devuelve el platforms_updated_at que esta misma PC pusheó, los timestamps empatan, y ' +
    'localPlatformsWins exige ">" estricto -- así que gana la nube y el descarte se revierte.',
  );
  assert.deepEqual(
    despues.platforms, [],
    'Instagram no debería volver a aparecer como publicada después de un descarte explícito.',
  );

  db.close();
});
