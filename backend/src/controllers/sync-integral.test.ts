// Harness INTEGRAL de convergencia — paso 5 de la Entrega 1
// (docs/sync-convergence-plan-2026-09-08.md).
//
// No hardcodea NINGUNA respuesta de la central: el `fetch` que sale de
// local-backend se enruta a los CONTROLADORES REALES, en el mismo proceso.
// Electron habla con la central de verdad; lo único falso es el transporte.
//
// Es el CONTRATO que la implementación debe cumplir, no una reproducción del
// incidente: varios casos están ROJOS porque el comportamiento todavía no
// existe (tombstone, precedencia por orden).
//
// MONGO. Por defecto SKIPea si no hay Mongo local (desarrollo normal). Con
// ESSE_REQUIRE_MONGO=1 FALLA en vez de saltear -- eso es lo que corre
// `npm run test:integration`, y es lo que tiene que correr el pipeline antes de
// mergear: si no, tres skips dan exit code 0 y el merge se ve verde sin haber
// probado nada.
//
// Correr:  cd backend && npm run test:integration

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

// Antes de cualquier import del repo: database.ts fija DB_PATH al cargarse.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esse-integral-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'integral.db');
delete process.env.ESSE_SYNC_METRICS;

const MONGO_URI = process.env.MONGO_TEST_URI ?? 'mongodb://127.0.0.1:27017/esse_sync_integral';
const REQUIRE_MONGO = process.env.ESSE_REQUIRE_MONGO === '1';
const USER_ID = new mongoose.Types.ObjectId().toString();
const AUTH = 'Bearer token-de-prueba';
const USER = { id: USER_ID, username: 'tester', role: 'editor', tier: 'free', hasCloudStorage: false };

const PLATFORM = 'instagram';
const PLATFORM_ID = '17999999999999999';
const PLATFORM_URL = 'https://www.instagram.com/reel/AAAAAAAAAAA/';

let central: any;

// ---------------------------------------------------------------------------
// Transporte hacia la central real
// ---------------------------------------------------------------------------

function fakeRes() {
  const captured: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    set() { return res; },
    status(code: number) { captured.status = code; return res; },
    json(body: any) { captured.body = body; return res; },
  };
  return { res, captured };
}

async function dispatch(
  handler: (req: any, res: any) => Promise<void> | void,
  req: Partial<{ params: any; query: any; body: any }>,
): Promise<Response> {
  const { res, captured } = fakeRes();
  await handler(
    { user: USER, headers: { authorization: AUTH }, params: {}, query: {}, body: {}, ...req },
    res,
  );
  return new Response(JSON.stringify(captured.body ?? {}), {
    status: captured.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Rutas que local-backend pega pero que NO son objeto de este harness. Se
// responden vacías a propósito. Todo lo que no esté acá ni tenga handler es un
// agujero del harness, no un éxito -- ver `unknown` abajo.
const RUTAS_IGNORADAS = [
  '/api/backup/transcripts',
  '/api/backup/ideas',
  '/api/sync/calendar-config',
  '/api/remote-library',
];

/**
 * Cómo se corta una entrega. Es lo único que hace falta simular para probar
 * una outbox: todo lo que la justifica pasa cuando la entrega falla.
 *
 *  - 'red':          el fetch revienta ANTES de llegar a la central. No se
 *                    aplicó nada del otro lado.
 *  - 'tras-aplicar': la central SÍ aplica y la respuesta se pierde en el
 *                    camino. Es el caso incómodo: el cliente no puede saber si
 *                    su operación corrió, y reintentarla a ciegas la aplicaría
 *                    dos veces.
 */
type ModoDeCorte = 'red' | 'tras-aplicar';

interface Router {
  calls: string[];
  /** Cuerpos enviados, para poder afirmar sobre el CONTRATO, no solo sobre la ruta. */
  cuerpos: { path: string; body: any }[];
  /** Devuelve cómo cortar esa llamada, o null para dejarla pasar. */
  cortar: ((method: string, path: string) => ModoDeCorte | null) | null;
  /** Milisegundos de demora para esa llamada. Sirve para dejar algo EN VUELO. */
  demorar: ((method: string, path: string) => number) | null;
  /**
   * Corre DESPUÉS de que la central calculó la respuesta y ANTES de que el
   * cliente la reciba. Es la ventana en la que el mundo cambia mientras una
   * respuesta viaja: lo que el cliente está por leer ya es pasado.
   */
  tras: ((method: string, path: string) => Promise<void> | void) | null;
  /** Responde en lugar de la central. Para probar respuestas que todavía no emite. */
  responder: ((method: string, path: string) => Response | null) | null;
  /** Rutas sin handler ni ignorar explícito. Debe quedar vacío. */
  unknown: string[];
  /** Espera a que no quede ningún fetch en vuelo (incluye los de setImmediate). */
  waitIdle: () => Promise<void>;
  restore: () => void;
}

function routeToCentral(): Router {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const cuerpos: { path: string; body: any }[] = [];
  const unknown: string[] = [];
  let pending = 0;
  const router: Partial<Router> = { cortar: null, demorar: null, tras: null, responder: null };

  globalThis.fetch = (async (input: any, init?: any) => {
    pending++;
    try {
      const raw = typeof input === 'string' ? input : String(input?.url ?? input);
      const url = new URL(raw);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(init.body) : {};
      const p = url.pathname;
      const query = Object.fromEntries(url.searchParams.entries());
      calls.push(method + ' ' + p);
      cuerpos.push({ path: p, body });

      const corte = router.cortar ? router.cortar(method, p) : null;
      // 'red' corta antes de despachar: la central no se entera de nada.
      if (corte === 'red') throw new TypeError('fetch failed');

      const demora = router.demorar ? router.demorar(method, p) : 0;
      if (demora > 0) await new Promise(r => setTimeout(r, demora));

      const propia = router.responder ? router.responder(method, p) : null;
      if (propia) return propia;

      if (method === 'POST' && p === '/api/backup/files/bulk') return await dispatch(central.bulkUpsertBackupFiles, { body });
      if (method === 'GET' && p === '/api/backup/files') {
        const r = await dispatch(central.getBackupFiles, { query });
        if (router.tras) await router.tras(method, p);
        return r;
      }
      if (method === 'POST' && p === '/api/backup/platform-videos/bulk') return await dispatch(central.bulkUpsertBackupPlatformVideos, { body });
      if (method === 'GET' && p === '/api/backup/platform-videos') return await dispatch(central.getBackupPlatformVideos, {});
      if (method === 'GET' && p === '/api/backup/config') return await dispatch(central.getBackupConfig, {});
      if (method === 'POST' && p === '/api/backup/config') return await dispatch(central.upsertBackupConfig, { body });
      if (method === 'POST' && (p === '/api/sync/history' || p === '/api/sync/record-publish')) {
        return await dispatch(central.recordUploadEvent, { body });
      }
      if (method === 'POST' && p === '/api/sync/resolve-identity') {
        return await dispatch(central.resolveIdentityEndpoint, { body });
      }
      if (method === 'POST' && p === '/api/sync/platform-transition') {
        const r = await dispatch(central.applyPlatformTransitionEndpoint, { body });
        // 'tras-aplicar': el efecto quedó, la respuesta se pierde.
        if (corte === 'tras-aplicar') throw new TypeError('fetch failed');
        return r;
      }
      if (method === 'DELETE' && p.startsWith('/api/sync/platform-link/')) {
        const parts = p.split('/');
        return await dispatch(central.unlinkPlatform, {
          params: { contentId: decodeURIComponent(parts[4]), platform: parts[5] },
        });
      }

      if (RUTAS_IGNORADAS.some(r => p === r || p.startsWith(r + '/'))) {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // 404 + registro. Antes esto devolvía 200 {} para CUALQUIER ruta
      // desconocida, así que una ruta NUEVA (por ejemplo
      // /api/sync/platform-transition) se habría dado por entregada sin que el
      // harness la despachara jamás: verde falso. No se lanza excepción porque
      // varios callers de local-backend hacen catch y se la tragarían; se
      // registra, y cada test afirma que quedó vacío.
      unknown.push(method + ' ' + p);
      return new Response(JSON.stringify({ message: 'ruta no enrutada por el harness' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      pending--;
    }
  }) as typeof fetch;

  // `pushFilesToCloudInBackground` (video.controller.ts) dispara con
  // setImmediate y no devuelve handle, así que sin esto el push de fondo corre
  // MIENTRAS el test arranca el ciclo siguiente: carrera real, resultados no
  // deterministas. Se drena el macrotask y se espera a que no quede ningún
  // fetch en vuelo, repetido hasta estabilizar (un push puede encadenar otro).
  //
  // Ojo con el reloj: drenar solo `setImmediate` NO alcanza. Cada fetch de acá
  // termina en una ida y vuelta real a Mongo, que tarda milisegundos; 100
  // turnos de setImmediate pasan en microsegundos. Mientras el push de fondo
  // fue corto el margen alcanzó, pero al sumarle el flush de transiciones dejó
  // de alcanzar y el harness declaraba "no terminó nunca" algo que solo estaba
  // tardando. Por eso mientras haya trabajo en vuelo se cede tiempo REAL, con
  // un presupuesto acotado para que un cuelgue de verdad siga siendo un error.
  const waitIdle = async () => {
    for (let intento = 0; intento < 600; intento++) {
      if (pending > 0) { await new Promise(r => setTimeout(r, 5)); continue; }
      await new Promise(r => setImmediate(r));
      if (pending === 0) {
        await new Promise(r => setImmediate(r));
        if (pending === 0) return;
      }
    }
    throw new Error('el push de fondo no terminó nunca: sigue habiendo fetch en vuelo');
  };

  Object.assign(router, { calls, cuerpos, unknown, waitIdle, restore: () => { globalThis.fetch = original; } });
  return router as Router;
}

// ---------------------------------------------------------------------------
// Estado: cada test siembra y limpia el suyo
// ---------------------------------------------------------------------------

async function conectarOSaltear(t: any): Promise<boolean> {
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(MONGO_URI) || MONGO_URI.includes('@')) {
    throw new Error('MONGO_TEST_URI debe ser un Mongo local descartable.');
  }
  if (mongoose.connection.readyState === 1) return true;
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000, autoIndex: false });
  } catch {
    if (REQUIRE_MONGO) {
      throw new Error(
        'ESSE_REQUIRE_MONGO=1 pero no hay Mongo en ' + MONGO_URI + '. Este harness es el que ' +
        'valida la convergencia: saltearlo deja pasar un merge sin haber probado nada.',
      );
    }
    t.skip('No hay Mongo local en ' + MONGO_URI + '. Corré `npm run test:integration` con el contenedor arriba.');
    return false;
  }
  return true;
}

/**
 * Construye los índices de las colecciones que el harness usa.
 *
 * `dropDatabase()` se lleva los índices con los datos, y la conexión va con
 * `autoIndex: false` -- así que sin esto los tests corrían SIN NINGÚN índice
 * único. Todo guard que dependa de un `E11000` (la reserva atómica de
 * operaciones, el upsert del tombstone, el del vínculo de identidad) no se
 * estaba ejercitando: la escritura que debía chocar simplemente insertaba un
 * duplicado, y el caso pasaba por otro motivo.
 */
async function construirIndices() {
  const modelos = [
    central.FileModel, central.BackupFileModel, central.PlatformVideoModel,
    central.BackupPlatformVideoModel, central.RemoteLibraryVideoModel,
    (await import('../models/platform-transition-op.model')).PlatformTransitionOpModel,
    (await import('../models/file-identity-binding.model')).FileIdentityBindingModel,
  ];
  // `init()` NO sirve acá: está memoizado por modelo, así que tras el primer
  // test no vuelve a construir nada y los índices se quedan caídos junto con la
  // base. `createIndexes()` los crea de verdad cada vez.
  await Promise.all(modelos.map((m: any) => m.createIndexes()));
}

/** Deja los dos lados en cero. Cada test parte de acá: sin herencia entre tests. */
async function limpiarEstado() {
  const { db } = await import('../../../local-backend/src/db/database');
  db.prepare('DELETE FROM platform_videos').run();
  db.prepare('DELETE FROM files').run();
  // Sin esto un test hereda las intenciones que el anterior dejó pendientes, y
  // el flush de un caso entrega la operación de otro.
  try { db.prepare('DELETE FROM transition_outbox').run(); } catch {}
  try { db.prepare('DELETE FROM platform_revisions').run(); } catch {}
  await mongoose.connection.dropDatabase();
  await construirIndices();
}

async function cargarCentral() {
  if (central) return;
  const backup = await import('./backup.controller');
  const sync = await import('./sync.controller');
  central = {
    ...backup,
    ...sync,
    FileModel: (await import('../models/file.model')).FileModel,
    BackupFileModel: (await import('../models/backup-file.model')).BackupFileModel,
    PlatformVideoModel: (await import('../models/platform-video.model')).PlatformVideoModel,
    BackupPlatformVideoModel: (await import('../models/backup-platform-video.model')).BackupPlatformVideoModel,
    RemoteLibraryVideoModel: (await import('../models/remote-library-video.model')).RemoteLibraryVideoModel,
  };
}

/** El MISMO video, publicado y confirmado, en las 6 representaciones. */
async function sembrarConfirmado() {
  const { fileRepo } = await import('../../../local-backend/src/db/file.repo');
  const { platformVideoRepo } = await import('../../../local-backend/src/db/platform-video.repo');

  const local = fileRepo.create({
    file_name: 'video integral.mp4',
    file_path: 'C:/videos/video integral.mp4',
  });
  const contentId = local.content_id!;
  fileRepo.addPlatform(local.id, PLATFORM as any);
  platformVideoRepo.upsert({
    platform: PLATFORM, platform_id: PLATFORM_ID, platform_url: PLATFORM_URL,
    linked_file_id: local.id, match_status: 'manual',
  });

  const publishedAt = new Date('2026-09-01T10:00:00.000Z');
  const centralFile = await central.FileModel.create({
    userId: USER_ID, file_name: local.file_name, file_path: local.file_name,
    content_id: contentId, status: 'PENDIENTE',
    platforms: [PLATFORM], platforms_discarded: [],
    platform_states: [{ platform: PLATFORM, state: 'confirmed' }],
    platforms_updated_at: publishedAt,
  });
  await central.BackupFileModel.create({
    userId: USER_ID, file_name: local.file_name, content_id: contentId,
    platforms: [PLATFORM], platforms_discarded: [],
    local_updated_at: publishedAt, platforms_updated_at: publishedAt,
  });
  await central.PlatformVideoModel.create({
    userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID,
    platformUrl: PLATFORM_URL, linkedFileId: centralFile._id,
    matchStatus: 'manual', publishedAt,
  });
  await central.BackupPlatformVideoModel.create({
    userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID,
    platform_url: PLATFORM_URL, file_name: local.file_name, content_id: contentId,
    match_status: 'manual', published_at: publishedAt, local_updated_at: publishedAt,
  });
  await central.RemoteLibraryVideoModel.create({
    userId: USER_ID, fileName: local.file_name, contentId,
    storedFileName: 'stored.mp4', sizeBytes: 1, durationSeconds: 1,
    platforms: [PLATFORM], platformsDiscarded: [],
    platformStates: [{ platform: PLATFORM, state: 'confirmed' }],
    platformLinks: [{ platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL, publishedAt }],
  });

  return { local, contentId };
}

/** Un ciclo igual que runSyncTick: push y después pull. */
async function cicloSync() {
  const mod = await import('../../../local-backend/src/controllers/backup-sync.controller');
  await mod.pushFilesToCloud(AUTH);
  const { res } = fakeRes();
  await mod.pullFromCloud({ headers: { authorization: AUTH } } as any, res as any);
}

async function fotoDelEstado(contentId: string) {
  const { fileRepo } = await import('../../../local-backend/src/db/file.repo');
  const { db } = await import('../../../local-backend/src/db/database');

  const localFile = fileRepo.findByContentId(contentId)!;
  const localLink = db
    .prepare('SELECT platform, platform_id, linked_file_id FROM platform_videos WHERE platform = ? AND linked_file_id = ?')
    .get(PLATFORM, localFile.id) as any;

  const [file, backupFile, pv, mirror, remote] = await Promise.all([
    central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean(),
    central.BackupFileModel.findOne({ userId: USER_ID, content_id: contentId }).lean(),
    central.PlatformVideoModel.findOne({ userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID }).lean(),
    central.BackupPlatformVideoModel.findOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID }).lean(),
    central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean(),
  ]);

  return {
    sqlite: { platforms: localFile.platforms, discarded: localFile.platforms_discarded, link: localLink ?? null },
    files: { platforms: file?.platforms ?? [], discarded: file?.platforms_discarded ?? [], states: file?.platform_states ?? [] },
    backupFiles: { platforms: backupFile?.platforms ?? [], discarded: backupFile?.platforms_discarded ?? [] },
    platformVideo: { linkedFileId: pv?.linkedFileId ?? null, matchStatus: pv?.matchStatus ?? null },
    mirror,
    remote: { platforms: remote?.platforms ?? [], discarded: remote?.platformsDiscarded ?? [], links: remote?.platformLinks ?? [] },
  };
}

/** El unlink tal como lo dispara Electron, esperando el push de fondo. */
async function unlinkDesdeElectron(localId: number, router: Router) {
  const { setPlatformLink } = await import('../../../local-backend/src/controllers/video.controller');
  const { res } = fakeRes();
  await setPlatformLink(
    { params: { fileId: String(localId), platform: PLATFORM }, body: { url: '' }, headers: { authorization: AUTH } } as any,
    res as any,
  );
  await router.waitIdle();
}

after(async () => {
  const { db } = await import('../../../local-backend/src/db/database');
  if (db.open) db.close();
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// CASO 1 — un unlink explícito sobrevive 3 ciclos completos.
// ---------------------------------------------------------------------------
test('INTEGRAL — un unlink explícito sobrevive 3 ciclos push/pull en las 6 representaciones', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    assert.deepEqual((await fotoDelEstado(contentId)).sqlite.platforms, [PLATFORM], 'precondición: arranca publicado');

    await unlinkDesdeElectron(local.id, router);

    for (let i = 1; i <= 3; i++) {
      await cicloSync();
      await router.waitIdle();
      const foto = await fotoDelEstado(contentId);

      assert.deepEqual(foto.sqlite.platforms, [], 'ciclo ' + i + ': SQLite no debe recuperar el badge');
      assert.equal(foto.sqlite.link, null, 'ciclo ' + i + ': SQLite no debe recuperar el link');
      assert.deepEqual(foto.files.platforms, [], 'ciclo ' + i + ': files no debe recuperar el badge');
      assert.deepEqual(foto.backupFiles.platforms, [], 'ciclo ' + i + ': backup_files no debe recuperar el badge');
      assert.equal(foto.platformVideo.linkedFileId, null, 'ciclo ' + i + ': el link real debe seguir desvinculado');
      assert.deepEqual(foto.remote.platforms, [], 'ciclo ' + i + ': Nube no debe recuperar el badge');
      assert.deepEqual(foto.remote.links, [], 'ciclo ' + i + ': Nube no debe recuperar el link');
    }
    assert.deepEqual(router.unknown, [], 'el harness no debe dejar rutas sin enrutar');
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// CASO 2 — una segunda PC tiene que enterarse del unlink.
//
// ROJO ESPERADO hasta implementar tombstone + LWW de links. Corre el ciclo
// COMPLETO (push y después pull), no solo el pull: una PC real pushea primero,
// y ese push viejo puede pisar el tombstone antes de llegar a leerlo. Por eso
// las dos piezas tienen que implementarse juntas.
// ---------------------------------------------------------------------------
test('INTEGRAL — una segunda PC recibe el tombstone del unlink tras un ciclo push/pull completo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    // PC #1 suelta la plataforma y sincroniza.
    await unlinkDesdeElectron(local.id, router);
    await cicloSync();
    await router.waitIdle();

    // PC #2: mismo video, todavía con el vínculo viejo. Se reconstruye sobre la
    // misma SQLite porque `db` es un singleton por proceso; el estado resultante
    // es idéntico al de esa otra máquina.
    const { fileRepo } = await import('../../../local-backend/src/db/file.repo');
    const { platformVideoRepo } = await import('../../../local-backend/src/db/platform-video.repo');
    platformVideoRepo.upsert({
      platform: PLATFORM, platform_id: PLATFORM_ID, platform_url: PLATFORM_URL,
      linked_file_id: local.id, match_status: 'manual',
    });
    fileRepo.addPlatform(local.id, PLATFORM as any);

    // Ciclo COMPLETO de la segunda PC: push (con su estado viejo) y luego pull.
    await cicloSync();
    await router.waitIdle();

    const foto = await fotoDelEstado(contentId);
    assert.equal(
      foto.sqlite.link, null,
      'La segunda PC tiene que soltar el vínculo. Hoy no puede: el servicio BORRA la fila del ' +
      'espejo en vez de dejar un tombstone, el pull no elimina jamás filas locales ausentes de la ' +
      'respuesta, y encima su propio push la resucita antes de que llegue a leerla.',
    );
    assert.deepEqual(foto.sqlite.platforms, [], 'ni el badge');
    assert.deepEqual(router.unknown, [], 'el harness no debe dejar rutas sin enrutar');
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// CASO 4 — el DESCARTE explícito, que es el camino que el snapshot ya no puede
// hacer. Contraparte del test reescrito en sync-convergence.test.ts: allá se
// exige que el push automático NO degrade un confirmed; acá se exige que la
// transición explícita SÍ pueda, y que aguante los ciclos.
// ---------------------------------------------------------------------------
test('INTEGRAL — un descarte explícito sobrevive 3 ciclos y queda discarded en todas las representaciones', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  const r = await applyPlatformTransition(USER_ID, {
    contentId, platform: PLATFORM as any, action: 'discard',
  });
  assert.equal(r.ok, true, 'la transición de descarte debería aplicarse');

  const router = routeToCentral();
  try {
    for (let i = 1; i <= 3; i++) {
      await cicloSync();
      await router.waitIdle();
      const foto = await fotoDelEstado(contentId);

      assert.deepEqual(foto.files.discarded, [PLATFORM], 'ciclo ' + i + ': files debe seguir descartada');
      assert.deepEqual(foto.files.platforms, [], 'ciclo ' + i + ': sin badge de publicada');
      assert.equal(
        (foto.files.states as any[]).find(s => s.platform === PLATFORM)?.state, 'discarded',
        'ciclo ' + i + ': el estado detallado debe decir discarded',
      );
      assert.deepEqual(foto.backupFiles.discarded, [PLATFORM], 'ciclo ' + i + ': backup_files igual');
      assert.equal(foto.sqlite.link, null, 'ciclo ' + i + ': sin link local');
      assert.deepEqual(foto.sqlite.discarded, [PLATFORM], 'ciclo ' + i + ': SQLite debe reflejar el descarte');
      assert.deepEqual(foto.remote.discarded, [PLATFORM], 'ciclo ' + i + ': Nube igual');
      assert.deepEqual(foto.remote.links, [], 'ciclo ' + i + ': Nube sin link');
    }
    assert.deepEqual(router.unknown, [], 'el harness no debe dejar rutas sin enrutar');
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// CASO 5 (regresión) — re-vincular EXACTAMENTE la misma publicación después de
// soltarla.
//
// `mirrorPlatformVideoToBackup` no tocaba `link_state`, así que la fila del
// espejo se quedaba con el tombstone puesto y el siguiente pull volvía a
// desvincular el video que el usuario acababa de re-vincular.
// ---------------------------------------------------------------------------
test('INTEGRAL — re-vincular el mismo platformId limpia el tombstone y sobrevive al ciclo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    await unlinkDesdeElectron(local.id, router);
    await cicloSync();
    await router.waitIdle();

    const trasUnlink = await fotoDelEstado(contentId);
    assert.equal(trasUnlink.mirror?.link_state, 'unlinked', 'precondición: quedó el tombstone');

    // El usuario vuelve a pegar el MISMO link.
    await central.applyPlatformPublish(USER_ID, {
      platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
      contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-01T10:00:00.000Z'),
    });

    await cicloSync();
    await router.waitIdle();

    const foto = await fotoDelEstado(contentId);
    assert.equal(
      foto.mirror?.link_state, 'linked',
      'Re-vincular tiene que resucitar el vínculo en el espejo. Si el tombstone sobrevive, el pull ' +
      'vuelve a desvincular lo que el usuario acaba de vincular.',
    );
    assert.deepEqual(foto.files.platforms, [PLATFORM], 'y la plataforma vuelve a estar publicada');
    assert.ok(foto.sqlite.link, 'y el link local vuelve a existir');
    assert.deepEqual(router.unknown, [], 'el harness no debe dejar rutas sin enrutar');
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// CASO 6 (regresión) — unlink cuando NO hay fila previa en el espejo.
//
// El tombstone se escribía con `updateMany` sin upsert: si la fila histórica
// faltaba (nunca se mirroreó, o la borró la versión anterior de este mismo
// servicio, que hacía deleteMany), no quedaba tombstone alguno y una PC vieja
// con el vínculo lo recreaba en su próximo push como si nada.
// ---------------------------------------------------------------------------
test('INTEGRAL — un unlink deja tombstone aunque el espejo no tuviera la fila', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();

  // Se borra la fila del espejo: simula el estado que dejaba la versión previa
  // del servicio, o un link que nunca llegó a mirrorearse.
  await central.BackupPlatformVideoModel.deleteMany({ userId: USER_ID, platform: PLATFORM });
  assert.equal(
    await central.BackupPlatformVideoModel.countDocuments({ userId: USER_ID, platform: PLATFORM }), 0,
    'precondición: el espejo quedó sin la fila',
  );

  const router = routeToCentral();
  try {
    await unlinkDesdeElectron(local.id, router);

    const tomb = await central.BackupPlatformVideoModel.findOne({
      userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID,
    }).lean();

    assert.ok(tomb, 'El tombstone tiene que crearse aunque no hubiera fila previa: sin él, otra PC ' +
      'con el vínculo lo recrea en su próximo push y el unlink no se propaga nunca.');
    assert.equal(tomb.link_state, 'unlinked', 'y tiene que estar marcado como desvinculado');
    assert.equal(tomb.content_id, contentId, 'con el content_id, que es lo que le dice a la otra PC qué soltar');
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// Helpers de semántica causal
// ---------------------------------------------------------------------------

/** Revisión vigente de una plataforma, tal como la publica la central. */
async function revisionDe(contentId: string, platform = PLATFORM): Promise<number> {
  const f = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  return ((f?.platform_rev ?? {}) as Record<string, number>)[platform] ?? 0;
}

/** Llama al endpoint real POST /api/sync/platform-transition. */
async function postTransicion(body: any) {
  const { res, captured } = fakeRes();
  await central.applyPlatformTransitionEndpoint(
    { user: USER, headers: { authorization: AUTH }, params: {}, query: {}, body } as any,
    res as any,
  );
  return captured;
}

// ---------------------------------------------------------------------------
// CASO 4 (reescrito) — una operación basada en una revisión vieja no destruye
// un cambio posterior.
//
// Antes este caso comparaba `stateChangedAt`, o sea el reloj del CLIENTE. Se
// cambió a `baseVersion` por decisión de diseño: un reloj de cliente no puede
// ser autoridad -- se desfasa (en este mismo repo se midió una deriva de 5 h
// por un bug de zona horaria), y una máquina adelantada podría declararse "más
// nueva" y pisar un cambio que en realidad ocurrió después. La revisión la
// emite el servidor.
// ---------------------------------------------------------------------------
test('INTEGRAL — una transición basada en una revisión vieja no destruye una publicación posterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const revVieja = await revisionDe(contentId);

  // Entremedio se republica con un link nuevo: eso mueve la revisión.
  await central.applyPlatformPublish(USER_ID, {
    platform: PLATFORM, platformId: '18888888888888888',
    platformUrl: 'https://www.instagram.com/reel/BBBBBBBBBBB/',
    contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
    // publishedAt VIEJO a propósito: vincular hoy un video de hace meses es un
    // cambio de estado nuevo. Si la precedencia mirara la fecha del video en
    // vez de la revisión, daría exactamente la respuesta equivocada.
    publishedAt: new Date('2026-01-15T10:00:00.000Z'),
  });
  assert.notEqual(await revisionDe(contentId), revVieja, 'republicar debe mover la revisión');

  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink',
    operationId: 'op-revision-vieja', baseVersion: revVieja,
  });

  assert.equal(r.status, 409, 'una operación basada en una revisión superada es conflicto');
  const foto = await fotoDelEstado(contentId);
  assert.deepEqual(foto.files.platforms, [PLATFORM], 'y la publicación posterior sigue en pie');
});

// ---------------------------------------------------------------------------
// CASO 8 (reescrito) — 409 con la revisión vigente, vía el endpoint real.
// ---------------------------------------------------------------------------
test('INTEGRAL — una transición atrasada responde 409 con la revisión vigente, no 404', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const revVieja = await revisionDe(contentId);

  await central.applyPlatformPublish(USER_ID, {
    platform: PLATFORM, platformId: '18888888888888888',
    platformUrl: 'https://www.instagram.com/reel/BBBBBBBBBBB/',
    contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
    publishedAt: new Date('2026-01-15T10:00:00.000Z'),
  });

  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink',
    operationId: 'op-atrasada-409', baseVersion: revVieja,
  });

  assert.equal(r.status, 409, 'con 404 la outbox reintentaría eternamente algo que nunca va a aplicar');
  assert.equal(r.body?.version, await revisionDe(contentId),
    'y devuelve la revisión VIGENTE, para que el cliente pueda rebasar en vez de adivinar');
});

// ---------------------------------------------------------------------------
// CASO 9 — reintento idéntico: misma operationId dos veces.
//
// Sin registro persistente, `operationId` no deduplica nada: el segundo intento
// vuelve a aplicar los efectos. Con una outbox reintentando, eso pasa siempre.
// ---------------------------------------------------------------------------
test('INTEGRAL — reintentar la MISMA operationId no vuelve a aplicar efectos', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'op-reintento-identico-1';

  const r1 = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  assert.equal(r1.status, 200);
  assert.equal(r1.body?.deduplicated, false, 'la primera entrega sí aplica');
  const revTrasPrimera = await revisionDe(contentId);

  // Segunda entrega: mismo operationId. Se manda el MISMO baseVersion viejo a
  // propósito -- así reintenta una outbox que nunca vio la respuesta.
  const r2 = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });

  assert.equal(r2.status, 200, 'un reintento de una operación ya aplicada no es un conflicto');
  assert.equal(r2.body?.deduplicated, true, 'y tiene que decir que no volvió a aplicar nada');
  assert.equal(await revisionDe(contentId), revTrasPrimera,
    'la revisión NO puede volver a moverse: si se mueve, se aplicó dos veces');

  const foto = await fotoDelEstado(contentId);
  assert.deepEqual(foto.files.discarded, [PLATFORM], 'y el estado final es el mismo');
});

// ---------------------------------------------------------------------------
// CASO 10 — entrega invertida: dos operaciones distintas que llegan al revés.
// ---------------------------------------------------------------------------
test('INTEGRAL — con entrega invertida gana la operación causalmente posterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);

  // Las dos se preparan sobre la MISMA revisión (el cliente las encoló sin
  // haber visto la respuesta de la primera).
  const opA = { contentId, platform: PLATFORM, action: 'discard', operationId: 'op-A', baseVersion: rev0 };
  const opB = { contentId, platform: PLATFORM, action: 'unlink', operationId: 'op-B', baseVersion: rev0 };

  // Llegan al revés: primero B.
  const rB = await postTransicion(opB);
  assert.equal(rB.status, 200, 'la primera en llegar se aplica');

  const rA = await postTransicion(opA);
  assert.equal(rA.status, 409,
    'la segunda venía basada en una revisión ya superada: tiene que rechazarse, no aplicarse encima');

  const foto = await fotoDelEstado(contentId);
  assert.deepEqual(foto.files.platforms, [], 'gana B (unlink): sin badge');
  assert.deepEqual(foto.files.discarded, [], 'y sin descarte, que es lo que habría dejado A');
});

// ---------------------------------------------------------------------------
// CASO 11 — plataformas concurrentes: no se pisan entre sí.
//
// El reloj por plataforma era un ARRAY que se leía, modificaba en JS y
// reescribía entero. Dos transiciones sobre plataformas distintas se pisaban
// (lost update). Con un mapa, `$inc` toca solo su propia clave.
// ---------------------------------------------------------------------------
test('INTEGRAL — transiciones concurrentes en dos plataformas no se pisan', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();

  // Se agrega YouTube al mismo archivo, para tener dos plataformas vivas.
  await central.applyPlatformPublish(USER_ID, {
    platform: 'youtube', platformId: 'YTAAAAAAAAA',
    platformUrl: 'https://www.youtube.com/shorts/YTAAAAAAAAA',
    contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
    publishedAt: new Date('2026-09-01T10:00:00.000Z'),
  });

  const revIg = await revisionDe(contentId, PLATFORM);
  const revYt = await revisionDe(contentId, 'youtube');

  // En paralelo, a propósito.
  const [rIg, rYt] = await Promise.all([
    postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: 'op-ig', baseVersion: revIg }),
    postTransicion({ contentId, platform: 'youtube', action: 'unlink', operationId: 'op-yt', baseVersion: revYt }),
  ]);

  assert.equal(rIg.status, 200, 'Instagram debe aplicarse');
  assert.equal(rYt.status, 200, 'y YouTube también: son hechos independientes');

  const f = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.deepEqual(f.platforms_discarded, [PLATFORM], 'quedó el descarte de Instagram');
  assert.ok(!(f.platforms ?? []).includes('youtube'), 'y YouTube quedó desvinculada');
  const revs = (f.platform_rev ?? {}) as Record<string, number>;
  assert.equal(revs[PLATFORM], revIg + 1, 'cada plataforma movió SU propia revisión');
  assert.equal(revs['youtube'], revYt + 1, 'sin pisar la de la otra');
});

// ---------------------------------------------------------------------------
// CASO 12 — recuperación de fallo parcial.
//
// Las 5 proyecciones son secuenciales y sin transacción: si el proceso se cae
// en el medio, el sistema queda a mitad de camino. La operación tiene que
// quedar registrada como `pending` y la próxima entrega tiene que REANUDARLA
// hasta que todas converjan, en vez de darla por hecha o por nueva.
// ---------------------------------------------------------------------------
test('INTEGRAL — una operación cortada a la mitad se reanuda hasta converger', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'op-fallo-parcial-1';

  // Se rompe la ÚLTIMA proyección (Nube) para cortar la operación por la mitad.
  const originalUpdateOne = central.RemoteLibraryVideoModel.updateOne.bind(central.RemoteLibraryVideoModel);
  central.RemoteLibraryVideoModel.updateOne = () => { throw new Error('caída simulada a mitad de la operación'); };

  let fallo: any = null;
  try {
    await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  } catch (err) {
    fallo = err;
  } finally {
    central.RemoteLibraryVideoModel.updateOne = originalUpdateOne;
  }

  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');
  const registro = await PlatformTransitionOpModel.findOne({ userId: USER_ID, operationId: op }).lean();
  assert.ok(registro, 'la operación tiene que haber quedado registrada ANTES de aplicar');
  assert.equal(registro.status, 'pending',
    'y NO puede figurar como completada: si se marca antes de terminar, nadie la reanuda');

  const parcial = await fotoDelEstado(contentId);
  assert.deepEqual(parcial.files.discarded, [PLATFORM], 'lo que sí alcanzó a aplicarse quedó aplicado');
  assert.deepEqual(parcial.remote.discarded, [], 'y lo que no, no (Nube quedó atrás)');

  // Reentrega de la MISMA operación: tiene que completar lo que faltaba.
  // Mientras el lease de la entrega que se cayó siga vigente, un reintento
  // recibe 202: la operación es válida (el claim lo dice) pero la está
  // trabajando otro ejecutor -- y nadie puede distinguir "ese proceso murió" de
  // "está tardando" sin esperar el vencimiento. Recién ahí se reanuda.
  const prematuro = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  assert.equal(prematuro.status, 202, 'con el lease de la entrega anterior vigente, todavía no');
  assert.equal(prematuro.body?.reason, 'in_progress');
  await vencerLease(op);

  const r = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  assert.equal(r.status, 200, 'reanudar no es conflicto');

  const final = await fotoDelEstado(contentId);
  assert.deepEqual(final.files.discarded, [PLATFORM], 'files sigue descartada');
  assert.deepEqual(final.remote.discarded, [PLATFORM], 'y Nube ya convergió');
  assert.deepEqual(final.remote.links, [], 'sin link en Nube');

  const cerrado = await PlatformTransitionOpModel.findOne({ userId: USER_ID, operationId: op }).lean();
  assert.equal(cerrado.status, 'completed', 'recién ahora la operación está completa');
});

// ---------------------------------------------------------------------------
// CASO 13 — semántica de las transiciones, contra el camino REAL.
//
// Estas garantías vivían en tests unitarios de `applyExplicitTransition`, una
// función pura que calculaba los arrays en JS. Esa función se eliminó al pasar
// a operadores atómicos de Mongo ($pull/$addToSet acotados a la plataforma):
// quedó sin usar en producción, así que sus 7 tests pasaban sin cubrir nada.
// Las mismas afirmaciones se mudaron acá, donde sí ejercitan lo que corre.
// ---------------------------------------------------------------------------
test('INTEGRAL — semántica: unlink deja la plataforma AUSENTE, discard la marca, y ninguna toca a las demás', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();

  // Una segunda plataforma, para poder afirmar que no se la toca.
  await central.applyPlatformPublish(USER_ID, {
    platform: 'youtube', platformId: 'YTBBBBBBBBB',
    platformUrl: 'https://www.youtube.com/shorts/YTBBBBBBBBB',
    contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
    publishedAt: new Date('2026-09-01T10:00:00.000Z'),
  });

  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  // discard: sin badge, en descartados, y `discarded` en el estado detallado.
  await applyPlatformTransition(USER_ID, { contentId, platform: PLATFORM as any, action: 'discard' });
  let f = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.deepEqual(f.platforms_discarded, [PLATFORM]);
  assert.ok(!(f.platforms ?? []).includes(PLATFORM), 'sin badge de publicada');
  assert.equal((f.platform_states ?? []).find((s: any) => s.platform === PLATFORM)?.state, 'discarded');
  assert.ok((f.platforms ?? []).includes('youtube'), 'la otra plataforma queda intacta');

  // unlink después de discard: no debe quedar rastro de esa plataforma.
  await applyPlatformTransition(USER_ID, { contentId, platform: PLATFORM as any, action: 'unlink' });
  f = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok(!(f.platforms ?? []).includes(PLATFORM), 'ni publicada');
  assert.ok(!(f.platforms_discarded ?? []).includes(PLATFORM), 'ni descartada');
  assert.equal(
    (f.platform_states ?? []).find((s: any) => s.platform === PLATFORM), undefined,
    '"pending" es la AUSENCIA en platform_states, no un 4º valor del enum',
  );
  assert.ok((f.platforms ?? []).includes('youtube'), 'y YouTube sigue sin enterarse');

  // Repetir el unlink es inocuo.
  const antes = JSON.stringify((await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean()).platforms);
  await applyPlatformTransition(USER_ID, { contentId, platform: PLATFORM as any, action: 'unlink' });
  const despues = JSON.stringify((await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean()).platforms);
  assert.equal(despues, antes, 'repetir una transición no cambia el resultado');

  // Una plataforma que nunca estuvo tampoco aparece de la nada.
  await applyPlatformTransition(USER_ID, { contentId, platform: 'tiktok' as any, action: 'unlink' });
  f = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok(!(f.platforms ?? []).includes('tiktok'), 'tiktok no se inventa');
  assert.ok(!(f.platforms_discarded ?? []).includes('tiktok'), 'ni en descartados');
});

// ===========================================================================
// P0 — huecos de la semántica causal. Rojos primero, como todo lo anterior.
// ===========================================================================

/** El registro de la operación, para poder afirmar sobre su ciclo de vida. */
async function registroDe(operationId: string) {
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');
  return PlatformTransitionOpModel.findOne({ userId: USER_ID, operationId }).lean();
}

// ---------------------------------------------------------------------------
// P0-1 — caída DESPUÉS de registrar `pending` pero ANTES del CAS.
//
// El servicio registra la operación como `pending` y recién después hace el CAS
// que incrementa la revisión. Si el proceso se cae entre esas dos cosas, al
// reanudar la rama `reanudando` SALTEA el CAS -- y la revisión nunca se
// incrementa. El bug de fondo es la suposición: `reanudando` da por hecho que
// el CAS ya corrió, y nada lo garantiza.
// ---------------------------------------------------------------------------
test('P0 — una caída entre `pending` y el CAS no puede dejar la revisión sin incrementar', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p0-caida-antes-del-cas';

  // Se rompe justo el CAS: findOneAndUpdate sobre FileModel es lo primero que
  // toca el servicio después de registrar la operación.
  const original = central.FileModel.findOneAndUpdate.bind(central.FileModel);
  central.FileModel.findOneAndUpdate = () => { throw new Error('caída simulada antes del CAS'); };
  try {
    await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  } catch { /* la caída es el escenario */ } finally {
    central.FileModel.findOneAndUpdate = original;
  }

  const reg = await registroDe(op);
  assert.ok(reg, 'la operación quedó registrada');
  assert.equal(reg!.status, 'pending', 'y quedó pendiente, que es lo correcto');
  assert.equal(await revisionDe(contentId), rev0, 'precondición: el CAS no llegó a correr');

  // Reentrega: tiene que completar de verdad, incluida la revisión.
  // Mientras el lease de la entrega que se cayó siga vigente, un reintento
  // recibe 202: la operación es válida (el claim lo dice) pero la está
  // trabajando otro ejecutor -- y nadie puede distinguir "ese proceso murió" de
  // "está tardando" sin esperar el vencimiento. Recién ahí se reanuda.
  const prematuro = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  assert.equal(prematuro.status, 202, 'con el lease de la entrega anterior vigente, todavía no');
  assert.equal(prematuro.body?.reason, 'in_progress');
  await vencerLease(op);

  const r = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  assert.equal(r.status, 200, 'la reanudación no es conflicto');

  assert.equal(
    await revisionDe(contentId), rev0 + 1,
    'La revisión TIENE que incrementarse al reanudar. Si se saltea el CAS porque la operación ' +
    'figura `pending`, queda en el valor viejo y cualquier operación posterior basada en él se ' +
    'cree al día: la precedencia deja de proteger nada.',
  );
  const foto = await fotoDelEstado(contentId);
  assert.deepEqual(foto.files.discarded, [PLATFORM], 'y el descarte quedó aplicado');
});

// ---------------------------------------------------------------------------
// P0-2 — el CAS no cubre las proyecciones.
//
// El CAS excluye a otra transición mientras se RECLAMA la revisión, y termina
// ahí. Las 5 escrituras quedan afuera: una publicación nueva puede entrar
// después del CAS y antes del $pull, y la transición vieja la destruye igual.
// ---------------------------------------------------------------------------
test('P0 — una publicación que entra DESPUÉS del CAS no puede ser destruida por la transición en curso', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);

  // Se intercala la publicación EN EL MEDIO: justo después de que el CAS
  // reclamó la revisión, antes de que las proyecciones escriban.
  const originalPull = central.FileModel.updateOne.bind(central.FileModel);
  let intercalado = false;
  central.FileModel.updateOne = async (...args: any[]) => {
    if (!intercalado) {
      intercalado = true;
      central.FileModel.updateOne = originalPull;
      await central.applyPlatformPublish(USER_ID, {
        platform: PLATFORM, platformId: '19999999999999999',
        platformUrl: 'https://www.instagram.com/reel/CCCCCCCCCCC/',
        contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
        publishedAt: new Date('2026-09-07T10:00:00.000Z'),
      });
      return originalPull(...args);
    }
    return originalPull(...args);
  };

  try {
    await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink',
      operationId: 'p0-carrera-con-publish', baseVersion: rev0,
    });
  } finally {
    central.FileModel.updateOne = originalPull;
  }

  assert.ok(intercalado, 'precondición: la publicación se intercaló de verdad');

  const foto = await fotoDelEstado(contentId);
  assert.deepEqual(
    foto.files.platforms, [PLATFORM],
    'La publicación que entró después del CAS tiene que sobrevivir. Hoy no: el CAS solo protege ' +
    'el claim de la revisión, y las proyecciones escriben después sin volver a validar contra qué ' +
    'versión están escribiendo.',
  );
});

// ---------------------------------------------------------------------------
// P0-3 — mismo `operationId`, payload distinto.
//
// No se valida que la operación ya registrada tenga el MISMO contentId,
// plataforma, acción y baseVersion. Con la misma clave y otro payload se puede
// reanudar -- o dar por completada -- una operación distinta.
// ---------------------------------------------------------------------------
test('P0 — reusar un operationId con otro payload se rechaza, no se confunde con la original', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  await central.applyPlatformPublish(USER_ID, {
    platform: 'youtube', platformId: 'YTCCCCCCCCC',
    platformUrl: 'https://www.youtube.com/shorts/YTCCCCCCCCC',
    contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
    publishedAt: new Date('2026-09-01T10:00:00.000Z'),
  });

  const op = 'p0-misma-clave-otro-payload';
  const revIg = await revisionDe(contentId, PLATFORM);

  const r1 = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: revIg });
  assert.equal(r1.status, 200, 'la primera se aplica');

  // MISMA clave, pero ahora dice YouTube + unlink.
  const revYt = await revisionDe(contentId, 'youtube');
  const r2 = await postTransicion({ contentId, platform: 'youtube', action: 'unlink', operationId: op, baseVersion: revYt });

  assert.notEqual(r2.status, 200,
    'Reusar una operationId con OTRO payload no puede aceptarse: la clave identifica una ' +
    'operación concreta, no un permiso para hacer cualquier cosa.');

  const f = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok((f.platforms ?? []).includes('youtube'),
    'y sobre todo: YouTube no puede haber quedado desvinculada por una clave que era de Instagram');
});

// ---------------------------------------------------------------------------
// P0-5 — transición concurrente con applyPlatformPublish.
//
// Son los dos caminos que escriben estado de plataforma. `applyPlatformPublish`
// todavía calcula y reemplaza `platform_states` desde una foto previa, así que
// sigue expuesto al mismo lost update que se sacó del servicio.
// ---------------------------------------------------------------------------
test('P0 — una transición y un publish concurrentes no se pisan el estado', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  // El intercalado se FUERZA, no se espera que ocurra: `Promise.all` a secas
  // deja el orden a merced del scheduler y un verde así no prueba nada -- puede
  // ser que la carrera simplemente no se dio. Acá se mete el descarte de
  // Instagram JUSTO entre la lectura y la escritura de `platform_states` que
  // hace applyPlatformPublish para YouTube, que es la ventana donde el lost
  // update puede pasar de verdad.
  const originalUpdateOne = central.FileModel.updateOne.bind(central.FileModel);
  let intercalado = false;
  central.FileModel.updateOne = async (...args: any[]) => {
    if (!intercalado) {
      intercalado = true;
      central.FileModel.updateOne = originalUpdateOne;
      await applyPlatformTransition(USER_ID, { contentId, platform: PLATFORM as any, action: 'discard' });
    }
    return originalUpdateOne(...args);
  };

  try {
    await central.applyPlatformPublish(USER_ID, {
      platform: 'youtube', platformId: 'YTDDDDDDDDD',
      platformUrl: 'https://www.youtube.com/shorts/YTDDDDDDDDD',
      contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-01T10:00:00.000Z'),
    });
  } finally {
    central.FileModel.updateOne = originalUpdateOne;
  }
  assert.ok(intercalado, 'precondición: la transición se intercaló de verdad');

  const f = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  const estados = (f.platform_states ?? []) as any[];

  assert.deepEqual(f.platforms_discarded, [PLATFORM], 'el descarte de Instagram sobrevive');
  assert.equal(estados.find(s => s.platform === PLATFORM)?.state, 'discarded',
    'con su estado detallado');
  assert.ok((f.platforms ?? []).includes('youtube'), 'y la publicación de YouTube también');
  assert.equal(estados.find(s => s.platform === 'youtube')?.state, 'confirmed',
    'con el suyo. applyPlatformPublish reemplaza platform_states desde una foto previa, así que ' +
    'puede borrar el estado que la transición acaba de escribir para la OTRA plataforma.');
});

// ===========================================================================
// P0 (segunda ronda) — huecos que quedaron DETRÁS del verde anterior.
// ===========================================================================

// ---------------------------------------------------------------------------
// P0-6 — caída DESPUÉS de un CAS exitoso pero ANTES de guardar `resultVersion`.
//
// El fix anterior reemplazó "inferir el claim del estado `pending`" por
// "inferirlo de `resultVersion`" -- pero `resultVersion` se guarda en una
// SEGUNDA escritura, sobre otro documento. Una caída entre el CAS y ese guardado
// deja la revisión YA incrementada y la operación sin claim reconocible: al
// reintentar, `baseVersion` ya no coincide y la operación muere como `stale`
// para siempre, sin haberse aplicado nunca.
//
// El claim tiene que quedar identificable en el MISMO update que lo hace.
// ---------------------------------------------------------------------------
test('P0 — una caída entre el CAS y el guardado de resultVersion no puede matar la operación', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p0-caida-post-cas';

  // Se rompe el updateOne que guarda `resultVersion` en la operación. El CAS
  // (findOneAndUpdate sobre FileModel) ya ocurrió y quedó persistido.
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');
  const originalUpdate = PlatformTransitionOpModel.updateOne.bind(PlatformTransitionOpModel);
  let rota = false;
  (PlatformTransitionOpModel as any).updateOne = (...args: any[]) => {
    if (!rota) { rota = true; throw new Error('caída simulada entre el CAS y el guardado del claim'); }
    return originalUpdate(...args);
  };

  try {
    await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  } catch { /* la caída es el escenario */ } finally {
    (PlatformTransitionOpModel as any).updateOne = originalUpdate;
  }

  assert.ok(rota, 'precondición: se cortó donde se quería');
  assert.equal(await revisionDe(contentId), rev0 + 1, 'precondición: el CAS SÍ alcanzó a incrementar');

  // La outbox reintenta con el MISMO baseVersion: es lo único que conoce.
  // Mientras el lease de la entrega que se cayó siga vigente, un reintento
  // recibe 202: la operación es válida (el claim lo dice) pero la está
  // trabajando otro ejecutor -- y nadie puede distinguir "ese proceso murió" de
  // "está tardando" sin esperar el vencimiento. Recién ahí se reanuda.
  const prematuro = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });
  assert.equal(prematuro.status, 202, 'con el lease de la entrega anterior vigente, todavía no');
  assert.equal(prematuro.body?.reason, 'in_progress');
  await vencerLease(op);

  const r = await postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 });

  assert.notEqual(
    r.status, 409,
    'La operación NO puede quedar muerta. Al reintentar, su propio CAS ya movió la revisión, así ' +
    'que baseVersion no coincide y se la rechaza como atrasada -- pero es la MISMA operación, no ' +
    'una rezagada. Sin un claim identificable en el update del CAS, no hay forma de distinguirlas.',
  );
  assert.equal(r.status, 200, 'tiene que reanudarse y completarse');

  const foto = await fotoDelEstado(contentId);
  assert.deepEqual(foto.files.discarded, [PLATFORM], 'y aplicar lo que pedía');
  assert.deepEqual(foto.remote.discarded, [PLATFORM], 'en todas las representaciones');
});

// ---------------------------------------------------------------------------
// P0-7 — el guard de versión solo protege `files`.
//
// La primera escritura va condicionada a la revisión reclamada, pero las que
// siguen (backup_files, platformvideos, tombstones, Nube) escriben sin ninguna
// condición. Una publicación que entre DESPUÉS del update de `files` y antes de
// las demás sigue siendo destruida por la transición vieja en esas otras
// proyecciones.
// ---------------------------------------------------------------------------
test('P0 — una publicación que entra entre proyecciones no puede ser destruida en las restantes', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);

  // Se intercala la publicación DESPUÉS del primer update de `files`: el guard
  // de versión ya pasó, y lo que viene escribe a ciegas.
  const originalUpdateOne = central.FileModel.updateOne.bind(central.FileModel);
  let intercalado = false;
  central.FileModel.updateOne = async (...args: any[]) => {
    const r = await originalUpdateOne(...args);
    if (!intercalado) {
      intercalado = true;
      central.FileModel.updateOne = originalUpdateOne;
      await central.applyPlatformPublish(USER_ID, {
        platform: PLATFORM, platformId: '17777777777777777',
        platformUrl: 'https://www.instagram.com/reel/DDDDDDDDDDD/',
        contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
        publishedAt: new Date('2026-09-07T12:00:00.000Z'),
      });
    }
    return r;
  };

  try {
    await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink',
      operationId: 'p0-entre-proyecciones', baseVersion: rev0,
    });
  } finally {
    central.FileModel.updateOne = originalUpdateOne;
  }

  assert.ok(intercalado, 'precondición: la publicación se intercaló entre proyecciones');

  const pv = await central.PlatformVideoModel.findOne({
    userId: USER_ID, platform: PLATFORM, platformId: '17777777777777777',
  }).lean();
  assert.ok(pv, 'la publicación nueva existe');
  assert.ok(
    pv.linkedFileId,
    'La publicación que entró entre proyecciones tiene que conservar su vínculo. Hoy no: el guard ' +
    'de versión cubre solo el primer update de `files`, y las proyecciones siguientes escriben sin ' +
    'condición, así que la transición vieja las pisa igual.',
  );

  const tomb = await central.BackupPlatformVideoModel.findOne({
    userId: USER_ID, platform: PLATFORM, platform_id: '17777777777777777',
  }).lean();
  assert.notEqual(tomb?.link_state, 'unlinked',
    'y tampoco puede quedar con tombstone: nunca se pidió desvincular ESA publicación');
});

// ---------------------------------------------------------------------------
// P0-8 — el mirror de Nube dentro de applyPlatformPublish (rojo FORZADO).
//
// `applyPlatformPublish` sigue haciendo read-modify-write de `platformStates`
// sobre RemoteLibraryVideoModel: lee la foto, calcula con `upsertConfirmed` y
// escribe el array entero. Es el mismo lost update que ya se corrigió en
// `FileModel`, en la misma función.
//
// Se fuerza el intercalado, igual que en el caso de FileModel: con `Promise.all`
// a secas el test pasa sin probar nada, porque la carrera puede no darse.
// ---------------------------------------------------------------------------
test('P0 — transición y publish concurrentes tampoco se pisan el estado en Nube', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  // Nube tiene que conocer las dos plataformas para que el lost update sea
  // observable.
  await central.RemoteLibraryVideoModel.updateOne(
    { userId: USER_ID, contentId },
    { $addToSet: { platforms: 'youtube', platformStates: { platform: 'youtube', state: 'badge_only' } } },
  );

  // El intercalado se mete entre la lectura y la escritura de platformStates
  // que hace el mirror de Nube.
  const originalRemoteUpdate = central.RemoteLibraryVideoModel.updateOne.bind(central.RemoteLibraryVideoModel);
  let intercalado = false;
  (central.RemoteLibraryVideoModel as any).updateOne = async (...args: any[]) => {
    if (!intercalado) {
      intercalado = true;
      (central.RemoteLibraryVideoModel as any).updateOne = originalRemoteUpdate;
      await applyPlatformTransition(USER_ID, { contentId, platform: PLATFORM as any, action: 'discard' });
    }
    return originalRemoteUpdate(...args);
  };

  try {
    await central.applyPlatformPublish(USER_ID, {
      platform: 'youtube', platformId: 'YTEEEEEEEEE',
      platformUrl: 'https://www.youtube.com/shorts/YTEEEEEEEEE',
      contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-01T10:00:00.000Z'),
    });
  } finally {
    (central.RemoteLibraryVideoModel as any).updateOne = originalRemoteUpdate;
  }

  assert.ok(intercalado, 'precondición: la transición se intercaló de verdad');

  const remote = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  const estados = (remote.platformStates ?? []) as any[];

  assert.ok(
    (remote.platformsDiscarded ?? []).includes(PLATFORM),
    'El descarte de Instagram tiene que sobrevivir en Nube. Hoy no: el mirror de applyPlatformPublish ' +
    'reemplaza platformStates desde una foto previa y borra lo que la transición acaba de escribir.',
  );
  assert.equal(estados.find(s => s.platform === PLATFORM)?.state, 'discarded',
    'con su estado detallado');
  assert.equal(estados.find(s => s.platform === 'youtube')?.state, 'confirmed',
    'y la publicación de YouTube también queda');
});

// ---------------------------------------------------------------------------
// P0-9 — una entrega simultánea idéntica debe deduplicar, no dar conflicto.
//
// El caso anterior aceptaba 200 o 409 como resultado válido para la segunda
// entrega. Eso no demuestra deduplicación: un 409 dice "tu operación quedó
// vieja", que semánticamente es otra cosa. Una outbox que lee 409 puede
// concluir que su operación se perdió y armar una nueva.
// ---------------------------------------------------------------------------
test('P0 — dos entregas simultáneas idénticas responden ambas OK, ninguna conflicto', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p0-simultaneas-dedup';
  const payload = { contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 };

  const [a, b] = await Promise.all([postTransicion(payload), postTransicion(payload)]);

  // Ninguna puede leer "tu operación quedó vieja": es la MISMA operación. Una
  // outbox que lea 409 puede creer que se perdió y armar una nueva.
  assert.ok(![a.status, b.status].includes(409), 'ninguna de las dos entregas puede dar conflicto');

  // Las dos respuestas legítimas son distintas y las dos son honestas:
  //   200 + deduplicated = la gemela YA terminó de aplicar.
  //   202 in_progress    = la gemela ganó el CAS y sigue aplicando.
  // Cuál de las dos toca depende de cuándo termine la ganadora, así que no se
  // fija una; lo que SÍ se exige es que sea una de esas dos, y que reintentar
  // converja. Ver el caso P1 de "deduplicada mientras la otra sigue aplicando":
  // responder 200 en la ventana de la segunda es lo que hacía que el cliente
  // diera por entregados efectos incompletos.
  for (const r of [a, b]) {
    assert.ok(r.status === 200 || r.status === 202, `respuesta inesperada: ${r.status}`);
    if (r.status === 202) assert.equal(r.body?.reason, 'in_progress');
  }
  assert.ok(
    [a.body?.deduplicated, b.body?.deduplicated].includes(true) || [a.status, b.status].includes(202),
    'una de las dos tiene que declararse deduplicada o en curso',
  );

  // Y una vez terminada, reintentar la misma operación converge a 200 + dedup.
  const reintento = await postTransicion(payload);
  assert.equal(reintento.status, 200);
  assert.equal(reintento.body?.deduplicated, true);
  assert.equal(await revisionDe(contentId), rev0 + 1, 'los efectos se aplican una sola vez');
});


// ===========================================================================
// ENTREGA 2 — OUTBOX LOCAL. Rojos primero, como todo lo anterior.
//
// Qué falta hoy, concretamente: `reportUnlinkPlatform` hace el DELETE y, si
// falla, lanza. El caller (setPlatformLink) lo atrapa, devuelve un
// `syncWarning` en el JSON... y ahí termina. La SQLite local YA quedó
// desvinculada. No queda registro de que la central no acompañó, ni nada que
// lo reintente. La intención se perdió, y el próximo pull puede resucitar el
// link porque del otro lado nunca pasó nada.
//
// La outbox es lo que vuelve durable esa intención. Y al volverla durable
// aparecen tres problemas que hoy no existen porque no hay reintento:
// deduplicar, no reintentar para siempre lo que nunca va a andar, y mantener
// el orden. Cada uno tiene su caso.
// ===========================================================================

/** Lo que la outbox local tiene encolado para ese archivo/plataforma. */
async function pendientesEnOutbox(contentId?: string): Promise<any[]> {
  const { db } = await import('../../../local-backend/src/db/database');
  try {
    return db.prepare(
      contentId
        ? `SELECT * FROM transition_outbox WHERE content_id = ? ORDER BY id ASC`
        : `SELECT * FROM transition_outbox ORDER BY id ASC`,
    ).all(...(contentId ? [contentId] : [])) as any[];
  } catch (err: any) {
    // Rojo explícito, no un error críptico de SQLite a mitad de un assert.
    throw new Error('No existe la outbox de transiciones en SQLite: ' + err.message);
  }
}

/** El reintento tal como lo dispara el server (arranque / push de fondo). */
async function flushOutbox() {
  const mod = await import('../../../local-backend/src/services/transition-outbox.service');
  return mod.flushTransitionOutbox(AUTH);
}

// ---------------------------------------------------------------------------
// OUT-1 — una desvinculación decidida con la central caída NO se pierde.
//
// Es el caso que justifica todo lo demás. Hoy el usuario ve el link
// desaparecer de su pantalla, la central nunca se entera, y no queda ni rastro
// de la intención: no hay nada que reintentar después.
// ---------------------------------------------------------------------------
test('OUTBOX — un unlink decidido con la central caída se entrega cuando vuelve', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    // La central no está. Todo lo que salga de local-backend hacia la
    // transición revienta como reviente un fetch sin red.
    router.cortar = (m, p) =>
      (p === '/api/sync/platform-transition' || p.startsWith('/api/sync/platform-link/')) ? 'red' : null;

    await unlinkDesdeElectron(local.id, router);

    // Punto de partida del caso: los dos lados quedaron en desacuerdo. Lo local
    // ya cambió (es la copia de esta PC y es lo que el usuario pidió) y la
    // central no se enteró.
    const durante = await fotoDelEstado(contentId);
    assert.equal(durante.sqlite.link, null, 'la SQLite local tenía que quedar desvinculada igual');
    assert.ok(durante.files.platforms.includes(PLATFORM),
      'con la entrega cortada la central no puede haberse enterado: si ya está desvinculada, ' +
      'el corte del harness no cortó nada y el caso no prueba lo que dice');

    // Vuelve la conectividad. Sin que el usuario vuelva a tocar nada, el
    // disparador normal ("algo cambió, sincronizá" -- el mismo que ya usa el
    // outbox de historial) tiene que reparar la divergencia.
    //
    // ESTA es la afirmación central del caso, y no menciona ninguna outbox: hoy
    // falla porque la intención se evaporó en el catch de setPlatformLink. No
    // hay nada que reintentar, y no lo va a haber nunca.
    router.cortar = null;
    const { pushFilesToCloudInBackground } = await import('../../../local-backend/src/controllers/backup-sync.controller');
    pushFilesToCloudInBackground(AUTH);
    await router.waitIdle();

    const despues = await fotoDelEstado(contentId);
    assert.ok(!despues.files.platforms.includes(PLATFORM),
      'la desvinculación se perdió: la central quedó vinculada y nada la reintenta');
    assert.equal(despues.platformVideo.linkedFileId, null, 'el vínculo central tenía que soltarse');

    // Y el detalle de cómo: encolada con su operationId, entregada, sin quedar
    // pendiente.
    const encoladas = await pendientesEnOutbox(contentId);
    assert.equal(encoladas.length, 1, 'la intención de desvincular tenía que quedar encolada');
    assert.equal(encoladas[0].platform, PLATFORM);
    assert.ok(encoladas[0].operation_id, 'sin operationId la central no puede deduplicar el reintento');
    assert.notEqual(encoladas[0].status, 'pending', 'ya entregada: no puede seguir pendiente');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// OUT-2 — el reintento no puede aplicar los efectos dos veces.
//
// El caso incómodo de toda outbox: la central APLICÓ y la respuesta se perdió.
// El cliente no tiene forma de saberlo, así que va a reintentar. Si el
// reintento genera un `operationId` nuevo, para la central es otra operación
// -- y una segunda operación con la misma `baseVersion` ya vieja es un
// conflicto, o peor, vuelve a correr los efectos.
// ---------------------------------------------------------------------------
test('OUTBOX — si se pierde la respuesta, el reintento no vuelve a aplicar nada', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const revInicial = await revisionDe(contentId);
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'tras-aplicar' : null);
    await unlinkDesdeElectron(local.id, router);

    // Del lado de la central ya se aplicó: la revisión avanzó.
    const revTrasAplicar = await revisionDe(contentId);
    assert.equal(revTrasAplicar, revInicial + 1, 'la central aplicó la transición');

    // El cliente, en cambio, la sigue viendo pendiente: nunca recibió respuesta.
    const encoladas = await pendientesEnOutbox(contentId);
    assert.equal(encoladas.length, 1);
    assert.equal(encoladas[0].status, 'pending');
    const opId = encoladas[0].operation_id;

    // Reintento con la red sana.
    router.cortar = null;
    const { entregadas } = await flushOutbox();

    // Se ENTREGÓ. No es un detalle: si el reintento se presentara como una
    // operación nueva, la central lo rechazaría por atrasado (su base ya no
    // describe el estado) y el usuario vería su desvinculación descartada por
    // conflicto cuando en realidad ya se había aplicado.
    assert.equal(entregadas, 1, 'el reintento tenía que entregarse, no quedar en conflicto');
    const mismaOp = await pendientesEnOutbox(contentId);
    assert.equal(mismaOp[0].operation_id, opId, 'el reintento tenía que reusar el MISMO operationId');
    assert.equal(mismaOp[0].status, 'delivered',
      'entregada, no en conflicto: la central tenía que reconocerla como el mismo trabajo');

    // Y reconocerla como el mismo trabajo significa no volver a aplicarla.
    assert.equal(await revisionDe(contentId), revTrasAplicar,
      'el reintento aplicó los efectos por segunda vez');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// OUT-3 — el `baseVersion` que se entrega es el que el usuario VIO al decidir,
// no el que hay al momento de entregar.
//
// Es la razón entera por la que la outbox guarda la revisión en vez de
// releerla al entregar. Si la releyera, una desvinculación decidida ayer sobre
// el estado de ayer se aplicaría contra el estado de hoy -- y borraría una
// publicación que entró en el medio, que es exactamente la familia de bugs que
// motivó todo esto.
// ---------------------------------------------------------------------------
test('OUTBOX — una intención encolada no destruye lo que se publicó mientras esperaba', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const revInicial = await revisionDe(contentId);
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await unlinkDesdeElectron(local.id, router);
    assert.equal((await pendientesEnOutbox(contentId)).length, 1, 'la intención tenía que quedar encolada');

    // Mientras la intención espera, el mismo video se publica de nuevo en esa
    // plataforma desde otro dispositivo. La revisión avanza.
    const NUEVO_ID = '17888888888888888';
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: NUEVO_ID,
      platformUrl: 'https://www.instagram.com/reel/BBBBBBBBBBB/',
      fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    const revTrasPublicar = await revisionDe(contentId);

    // Y esta PC se entera de la publicación nueva por el ciclo normal de sync:
    // a partir de acá CONOCE la revisión nueva. Es lo que separa las dos
    // lecturas posibles de `baseVersion` -- sin este ciclo, "la que se congeló
    // al decidir" y "la que hay al entregar" son el mismo número y el caso no
    // prueba nada.
    router.cortar = null;
    await cicloSync();
    await router.waitIdle();

    const { platformRevisionRepo } = await import('../../../local-backend/src/db/platform-revision.repo');
    assert.equal(platformRevisionRepo.get(contentId, PLATFORM), revTrasPublicar,
      'el pull tenía que traer la revisión nueva; si no, el caso vuelve a no distinguir nada');
    const encolada = (await pendientesEnOutbox(contentId))[0];
    assert.equal(Number(encolada.base_version), revInicial,
      'la intención tiene que seguir declarando la revisión que el usuario vio, no la de ahora');

    // Y ahora sí se entrega. Con la base congelada llega atrasada y la central
    // la rechaza. Con la base releída se aplicaría, y borraría la publicación.
    await flushOutbox();

    const foto = await fotoDelEstado(contentId);
    assert.ok(foto.files.platforms.includes(PLATFORM),
      'la publicación nueva fue destruida por una intención basada en un estado anterior');
    assert.equal(await revisionDe(contentId), revTrasPublicar,
      'una operación atrasada no puede mover la revisión');
    assert.equal((await pendientesEnOutbox(contentId))[0].status, 'conflict',
      'llegó tarde: tenía que archivarse como conflicto, no aplicarse');
    const pv = await central.PlatformVideoModel.findOne({ userId: USER_ID, platformId: NUEVO_ID }).lean();
    assert.ok(pv?.linkedFileId, 'el vínculo nuevo tenía que sobrevivir');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// OUT-4 — no todo se reintenta igual.
//
// Un fallo de red es transitorio: hay que insistir. Un 409 (la operación llegó
// tarde) y un 422 (esa clave ya identifica otra operación) NO se arreglan
// insistiendo -- reintentarlos para siempre es una fila que nunca se vacía y
// un log que nadie va a poder leer.
// ---------------------------------------------------------------------------
test('OUTBOX — un conflicto se resuelve y se archiva; un fallo de red sigue pendiente', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await unlinkDesdeElectron(local.id, router);

    // Un fallo de red deja la fila pendiente y suma un intento.
    await flushOutbox();
    let fila = (await pendientesEnOutbox(contentId))[0];
    assert.equal(fila.status, 'pending', 'un fallo de red es transitorio: tiene que seguir pendiente');
    assert.ok(fila.attempts >= 1, 'el intento fallido tenía que quedar contado');

    // Ahora el estado cambia debajo, así que la operación queda atrasada -> 409.
    router.cortar = null;
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: '17777777777777777',
      platformUrl: 'https://www.instagram.com/reel/CCCCCCCCCCC/',
      fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-07T12:00:00.000Z'),
    });

    await flushOutbox();
    fila = (await pendientesEnOutbox(contentId))[0];
    assert.notEqual(fila.status, 'pending',
      'un 409 no se arregla reintentando: la fila no puede quedar pendiente para siempre');

    // Y no se sigue intentando en los flushes siguientes.
    const intentosTrasConflicto = fila.attempts;
    await flushOutbox();
    assert.equal((await pendientesEnOutbox(contentId))[0].attempts, intentosTrasConflicto,
      'una operación ya resuelta no se puede seguir reintentando');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// OUT-5 — el orden por (contentId, plataforma) se respeta.
//
// La segunda operación sobre la misma plataforma se decidió SOBRE EL RESULTADO
// de la primera: su `baseVersion` es la revisión que la primera va a producir.
// Si el flush la entrega antes, llega con una base que todavía no existe y la
// central la rechaza -- y encima queda archivada como conflicto, o sea perdida,
// cuando en realidad solo había llegado temprano.
// ---------------------------------------------------------------------------
test('OUTBOX — dos intenciones sobre la misma plataforma se entregan en orden', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);

    // Primera intención: desvincular. Queda encolada, sin entregar.
    await unlinkDesdeElectron(local.id, router);
    // Segunda: se vuelve a vincular y a desvincular sobre el resultado de la
    // primera. Ambas viven en la cola a la vez.
    const { platformVideoRepo } = await import('../../../local-backend/src/db/platform-video.repo');
    platformVideoRepo.upsert({
      platform: PLATFORM, platform_id: PLATFORM_ID, platform_url: PLATFORM_URL,
      linked_file_id: local.id, match_status: 'manual',
    });
    await unlinkDesdeElectron(local.id, router);

    const cola = await pendientesEnOutbox(contentId);
    assert.equal(cola.length, 2, 'las dos intenciones tenían que quedar encoladas');
    assert.ok(cola[0].id < cola[1].id, 'la cola tiene que conservar el orden en que se decidieron');
    assert.notEqual(cola[0].operation_id, cola[1].operation_id,
      'son dos decisiones distintas: no pueden compartir operationId');
    assert.ok(
      Number(cola[1].base_version) > Number(cola[0].base_version),
      'la segunda se decidió sobre el resultado de la primera: su base tiene que ser posterior',
    );

    // Al entregar, la primera va primero. Si se invirtiera, la segunda llegaría
    // con una base inexistente.
    router.cortar = null;
    await flushOutbox();

    const entregadas = router.calls.filter(c => c === 'POST /api/sync/platform-transition');
    assert.ok(entregadas.length >= 2, 'las dos tenían que salir');
    const finales = await pendientesEnOutbox(contentId);
    assert.deepEqual(finales.filter(e => e.status === 'pending'), [],
      'ninguna puede quedar colgada tras un flush con la red sana');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});


// ---------------------------------------------------------------------------
// OUT-6 — dos flushes solapados no pueden inventar un problema.
//
// `setPlatformLink` dispara el push de fondo (que flushea) y enseguida encola
// la desvinculación y flushea otra vez. Con un guard de "si ya hay uno
// corriendo, salteá", la segunda llamada vuelve sin haber hecho nada y sin
// saber si la primera alcanzó a ver su fila -- el lote de `findPending` ya se
// había leído antes de que la fila existiera.
//
// Con red sana y la desvinculación entregándose bien, el usuario no puede
// recibir un aviso de que quedó pendiente. Es un falso positivo, y de los
// peores: enseña a ignorar el aviso justo cuando algún día sea cierto.
// ---------------------------------------------------------------------------
test('OUTBOX — un flush ya en vuelo no hace que la desvinculación se reporte como pendiente', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    const { flushTransitionOutbox } = await import('../../../local-backend/src/services/transition-outbox.service');
    const { setPlatformLink } = await import('../../../local-backend/src/controllers/video.controller');

    // Se deja un flush EN VUELO: hay una transición previa encolada de otra
    // plataforma, y su entrega tarda.
    const { transitionOutboxRepo } = await import('../../../local-backend/src/db/transition-outbox.repo');
    transitionOutboxRepo.enqueue({ contentId, platform: 'youtube', action: 'unlink', knownVersion: 0 });
    router.demorar = (m, p) => (p === '/api/sync/platform-transition' ? 60 : 0);
    const enVuelo = flushTransitionOutbox(AUTH);

    // Y en el medio el usuario desvincula. La red está sana: esto tiene que
    // salir bien y sin avisos.
    const { res, captured } = fakeRes();
    await setPlatformLink(
      { params: { fileId: String(local.id), platform: PLATFORM }, body: { url: '' }, headers: { authorization: AUTH } } as any,
      res as any,
    );
    await enVuelo;
    await router.waitIdle();

    assert.equal(captured.body?.syncWarning, undefined,
      'con red sana no puede avisar que quedó pendiente: la entrega salió bien');

    const fila = (await pendientesEnOutbox(contentId)).find(e => e.platform === PLATFORM);
    assert.ok(fila, 'la desvinculación tenía que quedar encolada');
    assert.equal(fila.status, 'delivered', 'y entregada');

    const foto = await fotoDelEstado(contentId);
    assert.ok(!foto.files.platforms.includes(PLATFORM), 'la central tenía que quedar desvinculada');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});


// ===========================================================================
// P1 — cuatro huecos del servicio central que sobrevivieron a las dos rondas
// anteriores. Rojos primero, como todo lo demás.
// ===========================================================================

/** Deja el estado "una operación reclamó y se cayó antes de terminar". */
async function reclamarYCaerse(contentId: string, op: string, baseVersion: number, action = 'unlink') {
  const { applyPlatformTransition } = await import('../services/platform-transition.service');
  const original = central.BackupFileModel.updateOne.bind(central.BackupFileModel);
  let rota = false;
  (central.BackupFileModel as any).updateOne = (...args: any[]) => {
    if (!rota) { rota = true; throw new Error('caída simulada después del CAS'); }
    return original(...args);
  };
  try {
    await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: action as any, operationId: op, baseVersion,
    });
    assert.fail('la caída simulada tenía que interrumpir la operación');
  } catch (err: any) {
    if (!/caída simulada/.test(err.message)) throw err;
  } finally {
    (central.BackupFileModel as any).updateOne = original;
  }
  const registro = await registroDe(op);
  assert.equal(registro?.status, 'pending', 'precondición: la operación quedó a medias');
}

// ---------------------------------------------------------------------------
// P1-1 — un claim que quedó de una operación anterior no puede sobrevivir a
// que OTRO escritor mueva la revisión.
//
// `platform_claim` se escribe junto al CAS, y eso resolvió el problema de
// reconocer una reanudación. Pero nadie lo BORRA: `applyPlatformPublish`
// incrementa `platform_rev` y deja el claim viejo intacto. Una entrega
// atrasada de esa operación se reconoce entonces como "reanudando", y reanudar
// SALTEA la comprobación de `baseVersion` y el CAS -- así que se aplica sobre
// la revisión nueva, destruyendo la publicación que entró en el medio.
//
// El claim no puede ser solo un nombre: tiene que decir QUÉ revisión reclamó.
// Si la revisión se movió, el claim ya no describe el presente.
// ---------------------------------------------------------------------------
test('P1 — un claim viejo no puede reanudarse después de que otro escritor movió la revisión', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p1-claim-viejo-tras-publish';

  await reclamarYCaerse(contentId, op, rev0);

  // Entra una publicación nueva en esa misma plataforma. Mueve la revisión y
  // deja el badge puesto otra vez.
  const NUEVO_ID = '17666666666666666';
  await central.applyPlatformPublish(USER_ID, {
    contentId, platform: PLATFORM, platformId: NUEVO_ID,
    platformUrl: 'https://www.instagram.com/reel/DDDDDDDDDDD/',
    fileName: 'video integral.mp4', matchStatus: 'manual',
    publishedAt: new Date('2026-09-08T12:00:00.000Z'),
  });
  const revTrasPublicar = await revisionDe(contentId);
  assert.ok(revTrasPublicar > rev0 + 1, 'precondición: la publicación movió la revisión');

  // Y recién ahí llega la entrega atrasada de la operación cortada.
  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: op, baseVersion: rev0,
  });

  const foto = await fotoDelEstado(contentId);
  assert.ok(
    foto.files.platforms.includes(PLATFORM),
    'La publicación nueva fue destruida por una operación que había reclamado una revisión anterior. ' +
    'El claim quedó vivo después de que applyPlatformPublish moviera la revisión, así que la entrega ' +
    'atrasada se creyó una reanudación y se saltó la comprobación de baseVersion.',
  );
  assert.equal(r.status, 409, 'la operación quedó atrasada: tiene que rechazarse, no reanudarse');
  assert.equal(await revisionDe(contentId), revTrasPublicar, 'y no puede mover la revisión');
});

// ---------------------------------------------------------------------------
// P1-2 — un alcance VACÍO es un alcance, no un "todavía no se calculó".
//
// El alcance se congela con la operación justamente para que una publicación
// posterior no entre en él. Pero la reanudación lo lee como
// `platformIds?.length > 0 ? guardado : recalcular` -- así que una operación
// cuyo alcance era legítimamente vacío (badge sin link, el caso de un video
// marcado a mano) vuelve a calcularlo al reanudar, y se lleva puesto lo que
// haya aparecido mientras tanto.
//
// La publicación acá NO pasa por el escritor único: entra por
// `PlatformVideoModel` directo, como todavía hacen los 5 callers sin migrar.
// Por eso no mueve la revisión y el guard de revisión no la protege -- el
// alcance es lo único que puede.
// ---------------------------------------------------------------------------
test('P1 — un alcance vacío no se recalcula al reanudar', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();

  // Se deja el archivo con el badge pero SIN vínculo: alcance vacío.
  await central.PlatformVideoModel.deleteMany({ userId: USER_ID, platform: PLATFORM });
  const rev0 = await revisionDe(contentId);
  const op = 'p1-alcance-vacio';

  await reclamarYCaerse(contentId, op, rev0);
  const registro = await registroDe(op);
  assert.deepEqual(registro?.platformIds ?? [], [], 'precondición: el alcance guardado está vacío');

  // Aparece un vínculo nuevo por un camino que no mueve la revisión.
  const file = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  const NUEVO_ID = '17555555555555555';
  await central.PlatformVideoModel.create({
    userId: USER_ID, platform: PLATFORM, platformId: NUEVO_ID,
    platformUrl: 'https://www.instagram.com/reel/EEEEEEEEEEE/',
    linkedFileId: file._id, matchStatus: 'manual',
    publishedAt: new Date('2026-09-08T12:00:00.000Z'),
  });

  // Se reanuda la operación cortada.
  await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: op, baseVersion: rev0,
  });

  const pv = await central.PlatformVideoModel.findOne({ userId: USER_ID, platformId: NUEVO_ID }).lean();
  assert.ok(
    pv?.linkedFileId,
    'El vínculo nuevo fue soltado por una operación cuyo alcance era vacío. Al reanudar, el alcance ' +
    'guardado ([]) se leyó como "no hay alcance" y se recalculó contra la base, incluyendo algo que ' +
    'la operación nunca había visto.',
  );
});

// ---------------------------------------------------------------------------
// P1-3 — el tombstone tampoco puede pisar una revisión posterior.
//
// El `updateMany` de tombstones sí compara `link_version`. El `updateOne` con
// upsert que viene justo después -- el que crea la lápida cuando la fila del
// espejo no existía -- no compara nada: escribe `link_state: 'unlinked'` y su
// propia `link_version` sobre lo que haya. Una transición vieja borra así un
// re-vínculo más nuevo que ya había llegado.
//
// REESCRITO. La versión anterior inyectaba `link_version: 99` en el espejo como
// "revisión posterior", pero ese 99 era una revisión de ARCHIVO: con una
// revisión propia del vínculo, una transición que decide DESPUÉS de esa
// escritura es la posterior, y tiene que ganar. La protección que el caso
// buscaba -- que la lápida no tape un re-vínculo decidido después que la
// transición -- se ejercita ahora con el camino real en el que se rompía: el
// mismo platformId se publica sobre OTRO archivo mientras la transición de A
// escribe el espejo. Los dos números del guard eran de archivos distintos.
// ---------------------------------------------------------------------------
test('P1 — el upsert del tombstone no puede pisar un link con revisión posterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  // La transición en A ya decidió: congeló su alcance con este vínculo adentro.
  // Mientras escribe el espejo, la MISMA publicación se vincula a OTRO archivo.
  const OTRO = '22222222-3333-4444-5555-666666666666';
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'updateMany', async () => {
    await central.applyPlatformPublish(USER_ID, {
      contentId: OTRO, platform: PLATFORM, platformId: PLATFORM_ID,
      platformUrl: PLATFORM_URL, fileName: 'otro video.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-09T12:00:00.000Z'),
    });
  });
  try {
    await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink',
      operationId: 'p1-tombstone-sobre-reasignado', baseVersion: rev0,
    });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la publicación sobre el otro archivo se intercaló de verdad');

  const otro = await central.FileModel.findOne({ userId: USER_ID, content_id: OTRO }).lean();
  const pv = await central.PlatformVideoModel
    .findOne({ userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID }).lean();
  assert.equal(String(pv?.linkedFileId), String(otro?._id), 'precondición: platformvideos ya lo tiene en el otro archivo');

  const mirror = await central.BackupPlatformVideoModel
    .findOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID }).lean();
  assert.deepEqual(
    [mirror?.link_state, mirror?.content_id], ['linked', OTRO],
    'La lápida de A tapó la publicación sobre el otro archivo. El guard comparaba la revisión de A con ' +
    'la que el publish selló, que era la revisión del OTRO archivo: números de dominios distintos, que ' +
    'acá empataban -- y ante el empate la transición vieja ganaba.',
  );
});

// ---------------------------------------------------------------------------
// P1-4 — "deduplicada" no puede significar "todavía se está aplicando".
//
// Cuando una entrega gemela pierde el CAS, hoy alcanza con que el claim lleve
// su operationId para responder 200 + deduplicated. Pero el claim se escribe al
// RECLAMAR, no al terminar: la gemela puede estar todavía a mitad de las
// proyecciones, o haberse caído ahí. El cliente lee 200, marca la fila como
// entregada y deja de reintentar -- sobre efectos que no están completos.
//
// Deduplicada tiene que significar "ya terminó". Mientras no terminó, la
// respuesta correcta es "todavía no, volvé a intentar" (202), que la outbox
// tiene que dejar pendiente.
// ---------------------------------------------------------------------------
test('P1 — una entrega gemela no puede declararse deduplicada mientras la otra sigue aplicando', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p1-dedup-antes-de-completar';
  const payload = { contentId, platform: PLATFORM, action: 'unlink', operationId: op, baseVersion: rev0 };

  // La que gane el CAS se queda frenada en su primera proyección. Durante esa
  // pausa, la que perdió ya respondió: es exactamente la ventana del caso.
  let enPausa = false;
  let yaPausada = false;
  const original = central.BackupFileModel.updateOne.bind(central.BackupFileModel);
  (central.BackupFileModel as any).updateOne = async (...args: any[]) => {
    if (!yaPausada) {
      yaPausada = true;
      enPausa = true;
      await new Promise(r => setTimeout(r, 300));
      enPausa = false;
    }
    return original(...args);
  };

  let perdedora: any;
  try {
    const [a, b] = await Promise.all([postTransicion(payload), postTransicion(payload)]);
    // La perdedora es la que no aplicó: la que declara deduplicated, o la que
    // no devolvió 200.
    perdedora = (a.body?.deduplicated || a.status !== 200) ? a : b;
    assert.ok(yaPausada, 'precondición: alguna llegó a las proyecciones');
  } finally {
    (central.BackupFileModel as any).updateOne = original;
  }

  assert.notEqual(
    perdedora.status, 200,
    'La gemela respondió 200 mientras la otra seguía a mitad de las proyecciones. El cliente marca ' +
    'la fila como entregada y deja de reintentar sobre efectos incompletos. Mientras no terminó, la ' +
    'respuesta correcta es 202 (todavía no, reintentá).',
  );
  assert.equal(perdedora.status, 202, 'y ese "todavía no" tiene que ser distinguible de un conflicto');
  assert.equal(perdedora.body?.reason, 'in_progress');
});


// ---------------------------------------------------------------------------
// P2 — la mutación local y el encolado son UNA sola escritura.
//
// Hoy `setPlatformLink` suelta el vínculo, saca el badge y RECIÉN DESPUÉS -- ya
// fuera de esa función, dentro de `reportUnlinkPlatform` -- encola la intención.
// Son tres escrituras a SQLite sin nada que las una. Una caída entre la segunda
// y la tercera deja exactamente el estado que la outbox venía a eliminar: lo
// local cambiado, la central sin enterarse, y nada encolado que lo reintente.
//
// La outbox no vale por guardar la intención, sino por guardarla en la misma
// transacción que el cambio que la origina. O están las tres, o no está ninguna.
// ---------------------------------------------------------------------------
test('P2 — si no se puede encolar la intención, el cambio local tampoco se aplica', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    const { transitionOutboxRepo } = await import('../../../local-backend/src/db/transition-outbox.repo');
    const { setPlatformLink } = await import('../../../local-backend/src/controllers/video.controller');
    const originalEnqueue = transitionOutboxRepo.enqueue;
    (transitionOutboxRepo as any).enqueue = () => { throw new Error('caída simulada al encolar'); };

    const { res, captured } = fakeRes();
    try {
      await setPlatformLink(
        { params: { fileId: String(local.id), platform: PLATFORM }, body: { url: '' }, headers: { authorization: AUTH } } as any,
        res as any,
      );
    } catch { /* que reviente o que devuelva 500: lo que importa es qué quedó escrito */ }
    finally {
      (transitionOutboxRepo as any).enqueue = originalEnqueue;
    }
    await router.waitIdle();

    const foto = await fotoDelEstado(contentId);
    assert.ok(
      foto.sqlite.link,
      'El vínculo local se soltó aunque la intención no se pudo encolar. Quedó el estado que la ' +
      'outbox venía a eliminar: lo local cambiado y nada que lo propague nunca.',
    );
    assert.ok(foto.sqlite.platforms.includes(PLATFORM), 'y el badge tampoco se puede haber ido');
    assert.deepEqual(await pendientesEnOutbox(contentId), [], 'no quedó nada encolado, que es la premisa');

    assert.notEqual(captured.status, 200,
      'y el cliente no puede recibir un OK por algo que no se aplicó');
  } finally {
    router.restore();
  }
});


// ---------------------------------------------------------------------------
// P3 — el estado y su revisión tienen que observarse JUNTOS.
//
// El pull traía primero los archivos y después, en otra llamada, las
// revisiones. Entre las dos respuestas cabe una publicación: la PC se queda con
// el estado de ANTES y la revisión de DESPUÉS.
//
// Esa combinación es peor que estar simplemente desactualizado. Una
// desvinculación decidida sobre el estado viejo sale declarando la revisión
// nueva, y la central la ACEPTA -- porque la revisión coincide. La protección
// causal entera se apoya en que `baseVersion` describa lo que el usuario vio, y
// acá describe otra cosa.
//
// Un cliente atrasado tiene que fallar con 409, no acertarle por casualidad.
// ---------------------------------------------------------------------------
test('P3 — una publicación llegada entre el estado y su revisión no puede ser destruida', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    // La publicación entra JUSTO DESPUÉS de que la central calculó la respuesta
    // de archivos. Todo lo que el cliente pida a partir de ahí ya la incluye.
    const NUEVO_ID = '17444444444444444';
    let publicado = false;
    router.tras = async () => {
      if (publicado) return;
      publicado = true;
      await central.applyPlatformPublish(USER_ID, {
        contentId, platform: PLATFORM, platformId: NUEVO_ID,
        platformUrl: 'https://www.instagram.com/reel/FFFFFFFFFFF/',
        fileName: 'video integral.mp4', matchStatus: 'manual',
        publishedAt: new Date('2026-09-08T15:00:00.000Z'),
      });
    };

    await cicloSync();
    await router.waitIdle();
    router.tras = null;
    assert.ok(publicado, 'precondición: la publicación se intercaló de verdad');

    const revReal = await revisionDe(contentId);
    const { platformRevisionRepo } = await import('../../../local-backend/src/db/platform-revision.repo');
    assert.notEqual(
      platformRevisionRepo.get(contentId, PLATFORM), revReal,
      'La PC se quedó con la revisión POSTERIOR a la publicación mientras su estado es el ANTERIOR. ' +
      'Estado y revisión se observaron en dos respuestas distintas, con una publicación en el medio.',
    );

    // Y la consecuencia: el usuario desvincula mirando el estado viejo.
    await unlinkDesdeElectron(local.id, router);

    const foto = await fotoDelEstado(contentId);
    assert.ok(
      foto.files.platforms.includes(PLATFORM),
      'La publicación que esta PC nunca vio fue destruida por una desvinculación que declaró una ' +
      'revisión que sí la incluía.',
    );
    const pv = await central.PlatformVideoModel.findOne({ userId: USER_ID, platformId: NUEVO_ID }).lean();
    assert.ok(pv?.linkedFileId, 'y el vínculo nuevo tenía que sobrevivir');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});


// ---------------------------------------------------------------------------
// P4 — no todo 2xx es "entregado".
//
// El flush marcaba la fila como entregada con cualquier `res.ok`. Eso confunde
// dos cosas distintas: "la central recibió esto" y "la central TERMINÓ de
// aplicarlo". Un 202 dice explícitamente la primera y no la segunda -- y desde
// el arreglo de las entregas gemelas, la central lo emite de verdad.
//
// Lo mismo vale para un 200 sin `version`: sin ese número el cliente no puede
// actualizar la revisión conocida, así que su próxima transición saldría con
// una base vencida. Dar por entregada una respuesta que no se entiende es
// perder la intención igual que perderla en la red, solo que en silencio.
// ---------------------------------------------------------------------------
test('P4 — un 202 deja la intención pendiente, no entregada', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.responder = (m, p) => (p === '/api/sync/platform-transition'
      ? new Response(JSON.stringify({ reason: 'in_progress' }), {
          status: 202, headers: { 'Content-Type': 'application/json' },
        })
      : null);

    await unlinkDesdeElectron(local.id, router);

    const fila = (await pendientesEnOutbox(contentId))[0];
    assert.ok(fila, 'la intención tenía que quedar encolada');
    assert.equal(
      fila.status, 'pending',
      'Un 202 dice "la recibí, todavía no terminó". Darla por entregada deja de reintentar sobre ' +
      'efectos incompletos -- que es exactamente lo que el 202 vino a evitar.',
    );

    // Y cuando la central responde de verdad, se entrega.
    router.responder = null;
    const { entregadas } = await flushOutbox();
    assert.equal(entregadas, 1, 'con la respuesta real tiene que entregarse');
    assert.equal((await pendientesEnOutbox(contentId))[0].status, 'delivered');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

test('P4 — un 200 sin revisión tampoco cuenta como entregado', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.responder = (m, p) => (p === '/api/sync/platform-transition'
      ? new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      : null);

    await unlinkDesdeElectron(local.id, router);

    assert.equal(
      (await pendientesEnOutbox(contentId))[0].status, 'pending',
      'Sin `version` el cliente no puede actualizar la revisión conocida, así que su próxima ' +
      'transición saldría con una base vencida. Una respuesta que no se entiende no es una entrega.',
    );
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});


// ===========================================================================
// P5 — tres ventanas que sobrevivieron a la ronda anterior.
// ===========================================================================

// ---------------------------------------------------------------------------
// P5-1 — la reserva del operationId tiene que ser atómica Y validada.
//
// El registro se crea con un `create` dentro de un try/catch que IGNORA el
// 11000. Ese catch da por hecho que un duplicado solo puede venir de otra
// entrega de la misma operación -- y no lo verifica.
//
// Con dos requests simultáneos, los dos leen "no existe" (así que ninguno pasa
// por la validación de payload, que solo corre si ya había registro), uno
// inserta y el otro se traga el 11000 y sigue como si hubiera reservado. La
// clave termina identificando una operación mientras OTRA, distinta, se aplica
// bajo su nombre.
//
// La reserva tiene que devolver siempre el registro canónico, y lo que siga
// tiene que comparar contra ÉL, no contra lo que se leyó antes.
// ---------------------------------------------------------------------------
test('P5 — dos payloads distintos con el mismo operationId no pueden aplicarse los dos', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p5-misma-clave-otro-payload';

  // Misma clave, acciones distintas. Solo una puede ser "la" operación.
  const [a, b] = await Promise.all([
    postTransicion({ contentId, platform: PLATFORM, action: 'unlink', operationId: op, baseVersion: rev0 }),
    postTransicion({ contentId, platform: PLATFORM, action: 'discard', operationId: op, baseVersion: rev0 }),
  ]);

  const rechazadas = [a, b].filter(r => r.status === 422);
  assert.equal(
    rechazadas.length, 1,
    'Exactamente una tiene que rechazarse por reusar la clave con otro payload. Las dos leyeron ' +
    '"no existe" antes de insertar, así que ninguna pasó por la validación, y la que perdió el ' +
    'índice único se tragó el 11000 y siguió igual: la clave identifica una operación y se aplicó otra.',
  );
  assert.equal(rechazadas[0].body?.reason, 'operation_mismatch');

  // Y el registro que quedó tiene que describir la que efectivamente se aplicó.
  const registro = await registroDe(op);
  const ganadora = [a, b].find(r => r.status !== 422)!;
  assert.ok(registro, 'la ganadora tiene que haber dejado su registro');
  const f = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  if (registro!.action === 'discard') {
    assert.ok((f!.platforms_discarded ?? []).includes(PLATFORM),
      'si la que reservó fue el descarte, es el descarte lo que tiene que quedar aplicado');
  } else {
    assert.ok(!(f!.platforms_discarded ?? []).includes(PLATFORM),
      'y si fue la desvinculación, no puede quedar aplicado un descarte que nunca reservó');
  }
  assert.equal(ganadora.status, 200);
});

// ---------------------------------------------------------------------------
// P5-2 — re-vincular el MISMO platformId mientras la transición está en curso.
//
// El alcance congelado protege de que una publicación NUEVA entre en la lista.
// No protege del caso contrario: que el mismo platformId que sí estaba en el
// alcance vuelva a vincularse mientras la transición avanza. Ese id sigue en la
// lista, así que la transición lo suelta igual -- y suelta una publicación
// posterior a ella.
//
// `platformvideos` no tiene versión: se desvincula directo, sin comparar nada.
// Y el mirror del publish tampoco sella `link_version` en
// `backup_platform_videos`, así que el guard del tombstone compara contra un
// valor ausente y también deja pasar la lápida.
// ---------------------------------------------------------------------------
test('P5 — re-publicar el mismo platformId a mitad de la transición no puede perderse', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  // La re-publicación entra justo después de que la transición tocó `files`.
  const originalBackup = central.BackupFileModel.updateOne.bind(central.BackupFileModel);
  let intercalado = false;
  (central.BackupFileModel as any).updateOne = async (...args: any[]) => {
    if (!intercalado) {
      intercalado = true;
      (central.BackupFileModel as any).updateOne = originalBackup;
      await central.applyPlatformPublish(USER_ID, {
        contentId, platform: PLATFORM, platformId: PLATFORM_ID,
        platformUrl: PLATFORM_URL, fileName: 'video integral.mp4', matchStatus: 'manual',
        publishedAt: new Date('2026-09-09T10:00:00.000Z'),
      });
    }
    return originalBackup(...args);
  };

  try {
    await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink',
      operationId: 'p5-revinculo-mismo-id', baseVersion: rev0,
    });
  } finally {
    (central.BackupFileModel as any).updateOne = originalBackup;
  }
  assert.ok(intercalado, 'precondición: la re-publicación se intercaló de verdad');

  const foto = await fotoDelEstado(contentId);
  assert.ok(foto.files.platforms.includes(PLATFORM), 'files conserva la publicación nueva');
  assert.ok(foto.backupFiles.platforms.includes(PLATFORM), 'backup_files también');
  assert.ok(
    foto.platformVideo.linkedFileId,
    'platformvideos conserva el vínculo. No tiene versión: la transición lo suelta directo, y el ' +
    'alcance congelado no ayuda porque ese platformId SÍ estaba en el alcance -- lo que cambió es ' +
    'que volvió a vincularse después.',
  );
  assert.equal(
    foto.mirror?.link_state, 'linked',
    'y el espejo no puede quedar con la lápida: el publish tampoco sella link_version, así que el ' +
    'guard del tombstone compara contra un valor ausente y deja pasar.',
  );
  assert.ok(foto.remote.platforms.includes(PLATFORM), 'Nube conserva la publicación');
  assert.ok((foto.remote.links as any[]).some(l => l.platform === PLATFORM), 'con su link');
});

// ---------------------------------------------------------------------------
// P5-3 — la revisión no puede viajar bajo la identidad equivocada.
//
// `getBackupFiles` mergea `backup_files` con `files` por `file_name`. Dos
// documentos distintos pueden compartir nombre y tener `content_id` distintos
// -- pasa con reimportaciones y con archivos renombrados a un nombre ya usado.
//
// Mientras el merge solo servía badges eso era un problema conocido de ese
// endpoint. Ahora además adjunta `platform_rev`, y la revisión es la identidad
// del estado: entregar la de un content_id bajo el nombre de otro deja al
// cliente declarando `baseVersion` de un archivo que no es el suyo.
//
// El nombre puede seguir sirviendo de fallback para el resto del merge; para la
// revisión, no.
// ---------------------------------------------------------------------------
test('P5 — la revisión se adjunta por content_id, nunca por nombre de archivo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();

  // OTRO archivo, mismo nombre, content_id distinto y una revisión muy
  // avanzada. `centralByName` se queda con el último que ve.
  const OTRO_CONTENT_ID = '11111111-2222-3333-4444-555555555555';
  await central.FileModel.create({
    userId: USER_ID, file_name: 'video integral.mp4', file_path: 'D:/otra copia/video integral.mp4',
    content_id: OTRO_CONTENT_ID, status: 'PENDIENTE',
    platforms: [PLATFORM], platforms_discarded: [],
    platform_states: [{ platform: PLATFORM, state: 'confirmed' }],
    platform_rev: { [PLATFORM]: 7 },
  });

  const router = routeToCentral();
  try {
    await cicloSync();
    await router.waitIdle();
  } finally {
    router.restore();
  }

  const { platformRevisionRepo } = await import('../../../local-backend/src/db/platform-revision.repo');
  const revReal = await revisionDe(contentId);
  assert.notEqual(
    platformRevisionRepo.get(contentId, PLATFORM), 7,
    'La PC guardó bajo ESTE content_id la revisión de OTRO archivo que solo comparte el nombre. ' +
    'La revisión es la identidad del estado: con la equivocada, la próxima transición declara la ' +
    'baseVersion de un archivo que no es el suyo.',
  );
  assert.ok(
    platformRevisionRepo.get(contentId, PLATFORM) <= revReal,
    'y nunca puede ser MÁS NUEVA que la real: informar de menos degrada a un 409, que se recupera; ' +
    'informar de más hace que la central acepte una decisión tomada sobre otra cosa',
  );
});


// ---------------------------------------------------------------------------
// P5-2 (bis) — la misma re-publicación, pero intercalada MÁS ADENTRO.
//
// El caso anterior la mete durante la escritura de `backup_files`, y ahí lo que
// salva es el chequeo de vigencia entre proyecciones: la transición se corta
// antes de llegar a las demás. Eso deja sin ejercitar justamente los guards por
// documento de esas otras representaciones -- lo confirmó una mutación: sacar
// el guard de `linkVersion` no rompía nada.
//
// Estos dos casos meten la re-publicación DENTRO de cada una de esas
// escrituras, cuando el chequeo de vigencia ya pasó. Ahí lo único que queda
// entre la transición vieja y la publicación nueva es el sello del documento.
// ---------------------------------------------------------------------------

/** Corre `intercalar` la primera vez que se llame a `modelo[metodo]`. */
async function conIntercaladoEn(modelo: any, metodo: string, intercalar: () => Promise<void>) {
  const original = modelo[metodo].bind(modelo);
  let hecho = false;
  modelo[metodo] = async (...args: any[]) => {
    if (!hecho) {
      hecho = true;
      modelo[metodo] = original;   // el intercalado usa el método de verdad
      await intercalar();
      modelo[metodo] = async (...a: any[]) => original(...a);
    }
    return original(...args);
  };
  return {
    restore: () => { modelo[metodo] = original; },
    get hecho() { return hecho; },
  };
}

test('P5 — re-publicar durante la escritura de platformvideos no puede soltar el vínculo nuevo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  const espia = await conIntercaladoEn(central.PlatformVideoModel, 'updateMany', async () => {
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: PLATFORM_ID,
      platformUrl: PLATFORM_URL, fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-09T11:00:00.000Z'),
    });
  });

  try {
    await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink',
      operationId: 'p5-revinculo-en-platformvideos', baseVersion: rev0,
    });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la re-publicación se intercaló de verdad');

  const foto = await fotoDelEstado(contentId);
  assert.ok(
    foto.platformVideo.linkedFileId,
    'El vínculo nuevo se soltó. Acá el chequeo de vigencia ya había pasado, así que lo único que ' +
    'podía salvarlo era el sello `linkVersion` del propio documento.',
  );
  assert.notEqual(foto.platformVideo.matchStatus, 'sin_match');
});

test('P5 — re-publicar durante el tombstone no puede dejar la lápida puesta', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'updateMany', async () => {
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: PLATFORM_ID,
      platformUrl: PLATFORM_URL, fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-09T12:00:00.000Z'),
    });
  });

  try {
    await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink',
      operationId: 'p5-revinculo-en-tombstone', baseVersion: rev0,
    });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la re-publicación se intercaló de verdad');

  const foto = await fotoDelEstado(contentId);
  assert.equal(
    foto.mirror?.link_state, 'linked',
    'La lápida tapó un re-vínculo posterior. El chequeo de vigencia ya había pasado: lo único que ' +
    'podía salvarlo era que el publish sellara `link_version` en el espejo.',
  );
});


// ===========================================================================
// P6 — dos P0 que el caso anterior no alcanzaba a ver.
// ===========================================================================

// ---------------------------------------------------------------------------
// P6-1 — coherencia de verdad: el estado y la revisión, del MISMO documento.
//
// El caso P5-3 solo comprobaba que la revisión no fuera la del OTRO archivo.
// Eso deja pasar la mitad del problema: el estado se sigue tomando de
// `centralByName` (que con nombres repetidos se queda con el último) y la
// revisión de `centralById`. O sea que se puede servir el estado de B con la
// revisión de A -- una pareja que nunca existió.
//
// Y es la pareja peligrosa: el cliente guarda la revisión correcta para SU
// identidad, así que su próxima transición pasa el CAS sin problema... aplicada
// sobre un estado que era de otro archivo.
// ---------------------------------------------------------------------------
test('P6 — el estado servido y su revisión salen del mismo documento', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // El documento central de ESTE archivo, con su estado y su revisión.
  await central.FileModel.updateOne(
    { userId: USER_ID, content_id: contentId },
    { $set: { platforms: [PLATFORM], platform_rev: { [PLATFORM]: 3 } } },
  );

  // Y otro archivo distinto, mismo nombre, con OTRO estado y OTRA revisión.
  // `centralByName` se queda con este.
  await central.FileModel.create({
    userId: USER_ID, file_name: 'video integral.mp4', file_path: 'D:/otra copia/video integral.mp4',
    content_id: '11111111-2222-3333-4444-555555555555', status: 'PENDIENTE',
    platforms: ['youtube'], platforms_discarded: ['tiktok'],
    platform_states: [{ platform: 'youtube', state: 'confirmed' }],
    platform_rev: { [PLATFORM]: 9, youtube: 4 },
  });

  const r = await dispatch(central.getBackupFiles, { query: { includeResolved: 'true' } });
  const { files } = await r.json() as { files: any[] };
  const fila = files.find(f => f.content_id === contentId);
  assert.ok(fila, 'precondición: el archivo tiene que venir en la respuesta');

  // Lo que se sirve tiene que describir a UN documento: el de este content_id.
  assert.deepEqual(
    [...(fila.platforms ?? [])].sort(), [PLATFORM],
    'El estado servido es el del OTRO archivo que solo comparte el nombre. Con la revisión ' +
    'tomada por content_id, la pareja estado+revisión que recibe el cliente nunca existió en ' +
    'ningún documento.',
  );
  assert.deepEqual([...(fila.platforms_discarded ?? [])].sort(), []);
  assert.equal((fila.platform_rev ?? {})[PLATFORM], 3,
    'y la revisión tiene que ser la de ese mismo documento');
});

// ---------------------------------------------------------------------------
// P6-2 — el publish tiene que usar LA revisión que ganó, no la que haya.
//
// `applyPlatformPublish` incrementa `platform_rev` y después la vuelve a LEER
// en tres momentos distintos para sellar sus proyecciones. Entre el incremento
// y esas lecturas cabe una transición posterior: el publish lee entonces la
// revisión de ELLA y sella sus propios efectos -- más viejos -- como si fueran
// de esa revisión.
//
// El resultado es lo peor de los dos mundos: los efectos del publish
// sobreviven a una operación causalmente posterior, y encima quedan marcados
// con su número, así que ningún guard puede distinguirlos después.
// ---------------------------------------------------------------------------
test('P6 — un publish no puede sellar sus efectos con la revisión de una transición posterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // El badge se saca del documento central para que este publish CAMBIE el
  // estado de verdad y por lo tanto mueva la revisión. Un publish que no cambia
  // nada no incrementa, y sin incremento no tiene revisión propia que sellar
  // -- el caso no probaría lo que dice.
  await central.FileModel.updateOne(
    { userId: USER_ID, content_id: contentId },
    { $set: { platforms: [], platform_states: [] } },
  );
  const rev0 = await revisionDe(contentId);
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  // La transición entra DESPUÉS de que el publish movió `files` y ANTES de que
  // el publish escriba sus proyecciones.
  let revTrasTransicion = -1;
  // Se intercala en el `FileModel.updateOne` que va JUSTO DESPUÉS del $inc del
  // publish. Ese es el punto: entre que el publish gana su revisión y que la
  // usa. Intercalar más tarde (en la escritura de platformvideos, por ejemplo)
  // no sirve -- para entonces el publish ya leyó todo lo que iba a leer, y el
  // caso no distingue "usé la revisión que gané" de "la releí".
  const espia = await conIntercaladoEn(central.FileModel, 'updateOne', async () => {
    const revTrasPublish = await revisionDe(contentId);
    assert.ok(revTrasPublish > rev0, 'precondición: el publish movió la revisión antes de ser interrumpido');
    const r = await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink',
      operationId: 'p6-transicion-posterior', baseVersion: revTrasPublish,
    });
    assert.ok(r.ok, 'precondición: la transición posterior tiene que aplicarse');
    revTrasTransicion = await revisionDe(contentId);
    assert.ok(revTrasTransicion > revTrasPublish, 'precondición: la transición movió la revisión');
  });

  try {
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: PLATFORM_ID,
      platformUrl: PLATFORM_URL, fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-09T13:00:00.000Z'),
    });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la transición se intercaló de verdad');

  const foto = await fotoDelEstado(contentId);
  assert.equal(
    foto.platformVideo.linkedFileId, null,
    'La desvinculación es causalmente POSTERIOR al publish y tiene que ganar. El publish releyó la ' +
    'revisión después de que la transición la moviera, así que volvió a vincular sellándolo con el ' +
    'número de ella.',
  );
  assert.equal(
    foto.mirror?.link_state, 'unlinked',
    'y el espejo tampoco: su upsert escribía `linked` sin comparar nada, así que el vínculo ' +
    'resucitaba en todas las PCs en su próximo pull',
  );
  const pv = await central.PlatformVideoModel
    .findOne({ userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID }).lean();
  // El último sello que quedó tiene que ser el de la operación causalmente
  // posterior. Si fuera el del publish, sus efectos habrían quedado escritos
  // encima -- y con un número que ningún guard posterior podría distinguir.
  assert.equal(
    pv?.linkVersion, revTrasTransicion,
    'el sello vigente tiene que ser el de la transición, que es la que ganó',
  );
});


// ===========================================================================
// OUTBOX CENTRAL — reparación de escrituras parciales (paso 9 del plan).
//
// Todo lo anterior evita que una operación superada siga DESTRUYENDO. Lo que
// no resuelve es lo que ya escribió antes de darse cuenta: se corta a mitad de
// camino, deja unas representaciones movidas y otras no, y su registro queda
// `pending` para siempre. Reprocesarla con la misma operación y el mismo
// alcance congelado va a fallar siempre igual -- su base ya no existe.
//
// Por eso la salida no puede ser "reintentar": tiene que ser reconocer que fue
// superada y REPARAR las proyecciones hacia el estado canónico de ahora, que ya
// no es el que esa operación quería imponer.
// ===========================================================================

/**
 * Hace que el lease de una operación quede vencido.
 *
 * Representa "pasó el tiempo": la request que la estaba aplicando dejó su lease
 * puesto y no volvió. Un worker no puede -- ni debe -- distinguir "el proceso se
 * murió" de "esto está tardando" sin esperar ese vencimiento; por eso hay que
 * simularlo en vez de asumir que la operación queda libre al instante.
 */
async function vencerLease(operationId: string) {
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');
  await PlatformTransitionOpModel.updateOne(
    { userId: USER_ID, operationId },
    { $set: { leaseUntil: new Date(Date.now() - 1000) } },
  );
}

/** Deja una transición cortada a la mitad y superada por una publicación. */
async function transicionSuperadaAMitad(contentId: string, op: string) {
  const { applyPlatformTransition } = await import('../services/platform-transition.service');
  const rev0 = await revisionDe(contentId);

  // La publicación entra cuando la transición ya movió `files` y `backup_files`
  // pero todavía no llegó al resto.
  const espia = await conIntercaladoEn(central.PlatformVideoModel, 'updateMany', async () => {
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: PLATFORM_ID,
      platformUrl: PLATFORM_URL, fileName: 'video integral.mp4', matchStatus: 'manual',
      publishedAt: new Date('2026-09-09T14:00:00.000Z'),
    });
  });

  let resultado: any;
  try {
    resultado = await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink', operationId: op, baseVersion: rev0,
    });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la publicación se intercaló de verdad');
  assert.equal(resultado.ok, false, 'precondición: la transición tiene que reconocer que perdió');
  return resultado;
}

test('OUTBOX CENTRAL — una operación parcial superada se repara y se cierra', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'central-superada';
  await transicionSuperadaAMitad(contentId, op);

  // La divergencia: `files` tiene la publicación (la re-agregó el publish) pero
  // `backup_files` se quedó con lo que alcanzó a escribir la transición. Nadie
  // repara eso hoy -- el publish no toca los badges de `backup_files`.
  const antes = await fotoDelEstado(contentId);
  assert.ok(antes.files.platforms.includes(PLATFORM), 'precondición: el estado canónico es "publicado"');
  assert.ok(
    !antes.backupFiles.platforms.includes(PLATFORM),
    'precondición: backup_files quedó con el efecto parcial de la transición',
  );
  assert.equal((await registroDe(op))?.status, 'pending',
    'precondición: la operación quedó pendiente, y reintentarla va a fallar siempre igual');

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');

  // Mientras el lease que dejó la request siga vigente, el worker NO la toca.
  // No puede distinguir "el proceso murió" de "está tardando", y equivocarse
  // hacia el lado de tocarla es lo que rompe una operación viva.
  const prematura = await repararTransicionesPendientes();
  assert.equal(prematura.revisadas, 0, 'con el lease de la request vigente, el worker no la toma');

  // Pasa el tiempo del lease y ahí sí.
  await vencerLease(op);
  const resumen = await repararTransicionesPendientes();

  const despues = await fotoDelEstado(contentId);
  assert.ok(
    despues.backupFiles.platforms.includes(PLATFORM),
    'La reparación tiene que llevar las proyecciones al estado canónico DE AHORA, no volver a ' +
    'imponer la transición vieja.',
  );
  assert.ok(despues.remote.platforms.includes(PLATFORM), 'ídem en Nube');

  const registro = await registroDe(op);
  assert.equal(
    registro?.status, 'superseded',
    'y la operación tiene que cerrarse con una salida explícita: dejarla `pending` es reintentar ' +
    'para siempre algo que nunca va a poder aplicarse.',
  );
  assert.equal(resumen.superadas, 1);

  // Y una segunda pasada no la vuelve a tomar.
  const segunda = await repararTransicionesPendientes();
  assert.equal(segunda.superadas, 0, 'ya cerrada: no se vuelve a procesar');
});

// ---------------------------------------------------------------------------
// El lease necesita un token, no solo un vencimiento.
//
// `leaseUntil` por sí solo no impide nada: un worker cuyo lease venció mientras
// trabajaba sigue teniendo la operación en la mano y puede escribir su
// resultado ENCIMA del worker nuevo que ya la tomó. Los dos creen ser dueños.
//
// `leaseOwner` es el fencing token: cerrar, liberar o registrar el error tiene
// que exigir el mismo token que reclamó. El que llega con uno vencido no
// escribe nada.
// ---------------------------------------------------------------------------
test('OUTBOX CENTRAL — un worker con el lease vencido no puede cerrar la operación del nuevo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'central-lease-vencido';
  await transicionSuperadaAMitad(contentId, op);

  const repair = await import('../services/transition-repair.service');
  await vencerLease(op);

  // Worker A toma la operación.
  const tomadaPorA = await repair.tomarOperacion(USER_ID, op, 'worker-A', 50);
  assert.ok(tomadaPorA, 'precondición: A tiene que poder tomarla');

  // Mientras el lease de A vale, nadie se la puede quitar. Sin esto el lease no
  // serializa nada y dos workers hacen el mismo trabajo en paralelo.
  assert.equal(
    await repair.tomarOperacion(USER_ID, op, 'worker-B', 60_000), false,
    'con el lease de A vigente, B no puede tomarla',
  );

  // Su lease vence y worker B la toma.
  await new Promise(r => setTimeout(r, 80));
  const tomadaPorB = await repair.tomarOperacion(USER_ID, op, 'worker-B', 60_000);
  assert.ok(tomadaPorB, 'precondición: con el lease vencido, B tiene que poder tomarla');

  // Y recién ahí A termina, tarde. No puede escribir nada.
  const cerroA = await repair.cerrarOperacion(USER_ID, op, 'worker-A', 'superseded', null);
  assert.equal(
    cerroA, false,
    'A llegó tarde: su lease ya no vale. Sin token, `leaseUntil` no impide que termine encima del ' +
    'worker nuevo -- los dos se creen dueños y el último en escribir gana.',
  );
  assert.equal((await registroDe(op))?.status, 'pending', 'y la operación sigue siendo de B');

  const cerroB = await repair.cerrarOperacion(USER_ID, op, 'worker-B', 'superseded', null);
  assert.equal(cerroB, true, 'B, que es el dueño, sí puede cerrarla');
  assert.equal((await registroDe(op))?.status, 'superseded');
});


// ---------------------------------------------------------------------------
// La otra salida: una operación que se cortó por una CAÍDA, sin que nadie la
// superara, sigue siendo la dueña de su revisión. Ahí no hay nada que reparar
// -- hay que terminarla. Repararla como si la hubieran superado sería tirar a
// la basura una decisión del usuario que nadie contradijo.
// ---------------------------------------------------------------------------
test('OUTBOX CENTRAL — una operación cortada por una caída se reanuda, no se descarta', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'central-reanudable';
  await reclamarYCaerse(contentId, op, rev0);

  // Quedó a medias: `files` ya perdió la plataforma, el resto no se enteró.
  const antes = await fotoDelEstado(contentId);
  assert.ok(!antes.files.platforms.includes(PLATFORM), 'precondición: alcanzó a mover files');
  assert.ok(antes.platformVideo.linkedFileId, 'precondición: no llegó a soltar el vínculo');

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  const resumen = await repararTransicionesPendientes();

  assert.equal(resumen.reanudadas, 1, 'nadie la superó: hay que TERMINARLA, no repararla');
  assert.equal(resumen.superadas, 0);

  const despues = await fotoDelEstado(contentId);
  assert.ok(!despues.files.platforms.includes(PLATFORM), 'la desvinculación queda');
  assert.ok(!despues.backupFiles.platforms.includes(PLATFORM), 'y llega a backup_files');
  assert.equal(despues.platformVideo.linkedFileId, null, 'y suelta el vínculo');
  assert.equal(despues.mirror?.link_state, 'unlinked', 'y deja el tombstone');
  assert.equal((await registroDe(op))?.status, 'completed');
});

// ---------------------------------------------------------------------------
// Un fallo transitorio no puede convertirse en un bucle cerrado. La operación
// se posterga con espera creciente, deja registrado POR QUÉ, y no se vuelve a
// tomar hasta que le toque.
// ---------------------------------------------------------------------------
test('OUTBOX CENTRAL — un fallo transitorio posterga con espera creciente y deja el motivo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'central-fallo-transitorio';
  await transicionSuperadaAMitad(contentId, op);

  const repair = await import('../services/transition-repair.service');

  // Se rompe la escritura que la reparación necesita hacer. (Parchear la
  // función exportada NO sirve: la llamada interna del worker no pasa por el
  // objeto del módulo, así que el parche no la alcanza y el caso pasaba sin
  // haber fallado nunca.)
  await vencerLease(op);
  const original = central.BackupFileModel.updateOne.bind(central.BackupFileModel);
  (central.BackupFileModel as any).updateOne = () => { throw new Error('Mongo no responde'); };

  let resumen: any;
  try {
    resumen = await repair.repararTransicionesPendientes();
  } finally {
    (central.BackupFileModel as any).updateOne = original;
  }

  assert.equal(resumen.pospuestas, 1, 'un fallo transitorio se posterga, no se cierra');
  const registro: any = await registroDe(op);
  assert.equal(registro?.status, 'pending', 'sigue pendiente: el trabajo no se hizo');
  assert.ok(registro?.attempts >= 1, 'el intento tiene que quedar contado');
  assert.match(String(registro?.lastError), /Mongo no responde/,
    'y el motivo registrado: una cola que falla sin decir por qué no se puede diagnosticar');
  assert.ok(registro?.nextAttemptAt && new Date(registro.nextAttemptAt) > new Date(),
    'con su turno en el futuro');
  assert.ok(!registro?.leaseOwner, 'y el lease liberado, para que otro worker pueda tomarla');

  // Y no se vuelve a tomar hasta que le toque.
  const segunda = await repair.repararTransicionesPendientes();
  assert.equal(segunda.revisadas, 0, 'todavía no es su turno');
});


// ===========================================================================
// P8 — dos huecos que el trigger del worker volvería observables.
// ===========================================================================

// ---------------------------------------------------------------------------
// P8-1 — el worker no puede tomar una operación que TODAVÍA SE ESTÁ APLICANDO.
//
// La request registra la operación como `pending` y recién después hace el CAS
// que escribe el claim. Entre esas dos cosas la operación existe, está viva, y
// no tiene claim -- que es exactamente el estado que el worker interpreta como
// "la superaron".
//
// Si el worker corre justo ahí, la cierra como `superseded`. La request sigue,
// gana el CAS, aplica la mitad y se cae: queda una transición parcial con
// estado TERMINAL, así que nadie la va a reparar nunca. El worker no rompe nada
// hoy solo porque no lo dispara nadie; cablearlo vuelve esto observable.
//
// La salida no es que el worker espere a las operaciones "nuevas": eso es una
// mitigación, no una solución -- una request lenta la sigue perdiendo. Request
// y worker tienen que usar el MISMO protocolo de lease.
// ---------------------------------------------------------------------------
test('P8 — el worker no puede tomar una operación que la request está aplicando', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p8-worker-vs-request';
  const { applyPlatformTransition } = await import('../services/platform-transition.service');
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');

  // El worker corre JUSTO entre la reserva y el CAS: la operación ya existe
  // como `pending` y todavía no escribió su claim.
  // El CAS encadena `.lean()` sobre el query, así que el intercalado tiene que
  // devolver algo con esa forma -- envolverlo en una promesa a secas rompe la
  // llamada antes de llegar a probar nada.
  let resumenDelWorker: any = null;
  let intercalado = false;
  const originalCas = central.FileModel.findOneAndUpdate.bind(central.FileModel);
  (central.FileModel as any).findOneAndUpdate = (...args: any[]) => {
    if (intercalado) return originalCas(...args);
    intercalado = true;
    return {
      lean: async () => {
        (central.FileModel as any).findOneAndUpdate = originalCas;
        resumenDelWorker = await repararTransicionesPendientes();
        return originalCas(...args).lean();
      },
    };
  };

  let resultado: any;
  try {
    resultado = await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink', operationId: op, baseVersion: rev0,
    });
  } finally {
    (central.FileModel as any).findOneAndUpdate = originalCas;
  }
  assert.ok(intercalado, 'precondición: el worker corrió entre la reserva y el CAS');

  assert.equal(
    resumenDelWorker?.revisadas, 0,
    'El worker tomó una operación que se estaba aplicando en ese mismo momento. La cerraría como ' +
    'superada, y la request seguiría igual: si se cae después del CAS queda una transición parcial ' +
    'con estado terminal, que ya nadie repara.',
  );

  const registro = await registroDe(op);
  assert.notEqual(registro?.status, 'superseded', 'y por lo tanto no puede quedar cerrada por el worker');
  assert.equal(registro?.status, 'completed', 'la request es la que la termina');
  assert.ok(resultado.ok, 'y la request tiene que poder completarla');

  const foto = await fotoDelEstado(contentId);
  assert.ok(!foto.files.platforms.includes(PLATFORM), 'con su efecto aplicado de verdad');
  assert.equal(foto.platformVideo.linkedFileId, null);
});

// ---------------------------------------------------------------------------
// P8-2 — la reparación tiene que arreglar también el estado NEGATIVO.
//
// `reproyectarPlataforma` sabe llevar los badges al estado canónico, pero solo
// sabe decir "esto está vinculado". Si el estado canónico es "desvinculado",
// no desvincula `platformvideos`, no deja tombstone en el espejo (solo marca
// `linked` los que encuentra) y no retira el `platformLink` de Nube.
//
// O sea: repara la mitad optimista y deja vínculos zombis en tres
// representaciones. Y esos zombis son justamente los que un pull vuelve a
// convertir en links visibles en todas las PCs.
//
// Para saber QUÉ ids limpiar no alcanza con mirar los vínculos vivos -- si ya
// no hay ninguno, no hay nada que enumerar. Hay que unir el alcance congelado
// de la operación, los vínculos actuales y los espejos de ese content_id.
// ---------------------------------------------------------------------------
test('P8 — la reparación desvincula, deja tombstone y retira el link de Nube', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');

  // Estado canónico: desvinculado. Pero los vínculos quedaron zombis en las
  // tres representaciones que la transición no alcanzó a tocar.
  await central.FileModel.updateOne(
    { userId: USER_ID, content_id: contentId },
    { $set: { platforms: [], platform_states: [], [`platform_rev.${PLATFORM}`]: 5 } },
  );

  const antes = await fotoDelEstado(contentId);
  assert.ok(antes.platformVideo.linkedFileId, 'precondición: el vínculo sigue vivo');
  assert.notEqual(antes.mirror?.link_state, 'unlinked', 'precondición: el espejo no tiene tombstone');
  assert.ok((antes.remote.links as any[]).some(l => l.platform === PLATFORM),
    'precondición: Nube conserva el link');

  // Una operación pendiente ya superada: es lo que el worker va a reparar.
  const op = 'p8-reparar-negativo';
  await PlatformTransitionOpModel.create({
    userId: USER_ID, operationId: op, contentId, platform: PLATFORM, action: 'unlink',
    baseVersion: 0, status: 'pending', platformIds: [PLATFORM_ID],
  });

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  const resumen = await repararTransicionesPendientes();
  assert.equal(resumen.superadas, 1, 'precondición: el worker la trata como superada');

  const despues = await fotoDelEstado(contentId);
  assert.equal(
    despues.platformVideo.linkedFileId, null,
    'La reparación dejó el vínculo vivo en platformvideos aunque el estado canónico es "desvinculado".',
  );
  assert.equal(
    despues.mirror?.link_state, 'unlinked',
    'y sin tombstone en el espejo, el próximo pull de CUALQUIER PC resucita el link',
  );
  assert.ok(
    !(despues.remote.links as any[]).some(l => l.platform === PLATFORM),
    'y Nube se queda con un platformLink que ya no corresponde a nada',
  );
  assert.ok(!despues.remote.platforms.includes(PLATFORM), 'con su badge también retirado');
  assert.ok(!despues.backupFiles.platforms.includes(PLATFORM));
});


// ---------------------------------------------------------------------------
// P8-3 — el cierre de la REQUEST también está fenced.
//
// El caso del fencing prueba `cerrarOperacion` (el camino del worker). El
// cierre de `applyPlatformTransition` es el otro lado del mismo protocolo y no
// lo miraba nadie: si la request tarda más que su lease y un worker toma la
// operación, la request no puede llegar tarde y declararla `completed` -- el
// dueño actual es quien decide cómo termina.
// ---------------------------------------------------------------------------
test('P8 — una request que perdió su lease no puede cerrar la operación', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p8-request-sin-lease';
  const { applyPlatformTransition } = await import('../services/platform-transition.service');
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');

  // Alguien le saca el lease mientras la request está en su última proyección.
  const espia = await conIntercaladoEn(central.RemoteLibraryVideoModel, 'updateOne', async () => {
    await PlatformTransitionOpModel.updateOne(
      { userId: USER_ID, operationId: op },
      { $set: { leaseOwner: 'worker-que-la-tomo', leaseUntil: new Date(Date.now() + 60_000) } },
    );
  });

  try {
    await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink', operationId: op, baseVersion: rev0,
    });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el lease se le fue a otro durante la aplicación');

  const registro: any = await registroDe(op);
  assert.equal(
    registro?.status, 'pending',
    'La request cerró una operación que ya no era suya. El dueño actual es quien tiene que decidir ' +
    'cómo termina -- si no, dos actores escriben el desenlace y gana el último.',
  );
  assert.equal(registro?.leaseOwner, 'worker-que-la-tomo', 'y el lease sigue siendo del otro');
});

// ---------------------------------------------------------------------------
// P8-4 — sin vínculos vivos NO hay nada que enumerar, y ahí está el problema.
//
// El caso anterior deja vínculos zombis en las tres representaciones, así que
// los ids se pueden sacar de `platformvideos`. Pero el caso feo es el otro: la
// transición SÍ alcanzó a soltar el vínculo y no llegó al espejo. Ahí no queda
// ningún vínculo vivo del que sacar el id, y el espejo -- que es de donde cada
// PC reconstruye sus links -- se queda diciendo `linked` para siempre.
//
// Por eso los ids salen de la unión del alcance congelado, los vínculos
// actuales y los espejos de ese content_id.
// ---------------------------------------------------------------------------
test('P8 — el tombstone se puede crear aunque ya no quede ningún vínculo vivo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');

  // Estado canónico: desvinculado. El vínculo YA se soltó. El espejo no se
  // enteró.
  await central.FileModel.updateOne(
    { userId: USER_ID, content_id: contentId },
    { $set: { platforms: [], platform_states: [], [`platform_rev.${PLATFORM}`]: 5 } },
  );
  await central.PlatformVideoModel.updateMany(
    { userId: USER_ID, platform: PLATFORM },
    { $set: { linkedFileId: null, matchStatus: 'sin_match' } },
  );

  const antes = await fotoDelEstado(contentId);
  assert.equal(antes.platformVideo.linkedFileId, null, 'precondición: no queda vínculo vivo');
  assert.notEqual(antes.mirror?.link_state, 'unlinked', 'precondición: el espejo sigue diciendo linked');

  const op = 'p8-sin-vinculos-vivos';
  await PlatformTransitionOpModel.create({
    userId: USER_ID, operationId: op, contentId, platform: PLATFORM, action: 'unlink',
    baseVersion: 0, status: 'pending', platformIds: [PLATFORM_ID],
  });

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  assert.equal((await repararTransicionesPendientes()).superadas, 1);

  const despues = await fotoDelEstado(contentId);
  assert.equal(
    despues.mirror?.link_state, 'unlinked',
    'Sin vínculos vivos no hay de dónde sacar el platformId mirando `platformvideos`. Si los ids ' +
    'salen solo de ahí, el espejo se queda diciendo `linked` y cada PC resucita el link en su ' +
    'próximo pull.',
  );
});


// ---------------------------------------------------------------------------
// P9 — el worker no puede perder su propio token al reanudar.
//
// `procesar()` toma el lease (token W) y después llama a
// `applyPlatformTransition`, que genera SU PROPIO token (R). Como al reanudar
// el claim prueba propiedad, esa función reemplaza W por R sin preguntar.
//
// Si la reanudación falla a mitad de camino, el worker intenta liberar la
// operación con W -- que ya no es el token vigente. No matchea nada: no queda
// `lastError`, no se programa `nextAttemptAt`, y el lease queda puesto con un
// token interno que ya no existe en ningún lado. La operación queda trabada
// hasta que ese lease venza, sin registro de por qué.
//
// El caso de fallo transitorio que ya existía solo cubre la rama
// `superseded`/reproyectar. Esta es la otra rama.
//
// La corrección conceptual: el claim prueba que la operación sigue siendo
// causalmente VÁLIDA; el lease prueba QUÉ EJECUTOR puede trabajarla ahora. Son
// cosas distintas, y `reanudando` solo prueba la primera.
// ---------------------------------------------------------------------------
test('P9 — si la reanudación falla, el worker conserva su lease y registra el motivo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p9-reanudacion-fallida';
  await reclamarYCaerse(contentId, op, rev0);
  await vencerLease(op);

  const repair = await import('../services/transition-repair.service');

  // Falla una proyección DENTRO de la reanudación, no en la reparación.
  const original = central.BackupPlatformVideoModel.updateMany.bind(central.BackupPlatformVideoModel);
  (central.BackupPlatformVideoModel as any).updateMany = () => { throw new Error('Mongo se cayó al reanudar'); };

  let resumen: any;
  try {
    resumen = await repair.repararTransicionesPendientes();
  } finally {
    (central.BackupPlatformVideoModel as any).updateMany = original;
  }

  assert.equal(resumen.pospuestas, 1, 'un fallo al reanudar se posterga, igual que cualquier otro');

  const registro: any = await registroDe(op);
  assert.equal(registro?.status, 'pending', 'sigue pendiente: no se aplicó');
  assert.ok(
    !registro?.leaseOwner,
    'El lease quedó puesto con un token que ya no tiene dueño. applyPlatformTransition generó el ' +
    'suyo y reemplazó el del worker, así que el worker no pudo liberar nada -- la operación queda ' +
    'trabada hasta que ese lease venza.',
  );
  assert.match(String(registro?.lastError), /Mongo se cayó al reanudar/,
    'y sin poder escribir el motivo, una cola trabada no se puede diagnosticar');
  assert.ok(registro?.nextAttemptAt && new Date(registro.nextAttemptAt) > new Date(),
    'con su turno programado');
});

// ---------------------------------------------------------------------------
// La otra mitad de la misma distinción: una entrega HTTP no puede quitarle la
// operación a quien la está trabajando, ni siquiera reanudando.
// ---------------------------------------------------------------------------
test('P9 — una entrega HTTP no puede robarle el lease a quien la está trabajando', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const op = 'p9-http-no-roba';
  await reclamarYCaerse(contentId, op, rev0);
  await vencerLease(op);

  // Un worker la toma y se pone a trabajarla.
  const repair = await import('../services/transition-repair.service');
  assert.ok(await repair.tomarOperacion(USER_ID, op, 'worker-en-curso', 60_000));

  // Y en el medio llega una entrega HTTP de la misma operación. El claim dice
  // que sigue siendo válida, pero eso no la hace suya.
  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: op, baseVersion: rev0,
  });

  assert.equal(
    r.status, 202,
    'El claim prueba que la operación sigue siendo causalmente válida, no que esta entrega sea ' +
    'quien puede trabajarla. Con otro ejecutor en curso, la respuesta honesta es "todavía no".',
  );
  assert.equal(r.body?.reason, 'in_progress');

  const registro: any = await registroDe(op);
  assert.equal(registro?.leaseOwner, 'worker-en-curso', 'y el lease sigue siendo de quien lo tomó');
});


// ===========================================================================
// P10 — el cableado del worker.
//
// Tres propiedades del disparador que pueden fallar EN SILENCIO, que es la
// razón por la que tienen caso propio: un guard de solapamiento que no guarda
// nada, un backoff sin jitter y unas métricas que no miran lo que dicen mirar
// se ven exactamente igual que los que sí funcionan.
// ===========================================================================

test('P10 — dos pasadas solapadas en el mismo proceso no corren a la vez', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // VARIAS operaciones pendientes. Con una sola no se prueba nada: el lease ya
  // la serializa, las otras pasadas no encuentran trabajo, y el guard del
  // proceso queda sin ejercitar aunque no exista.
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');
  await PlatformTransitionOpModel.create(
    Array.from({ length: 6 }, (_, i) => ({
      userId: USER_ID, operationId: `p10-solapadas-${i}`, contentId,
      platform: PLATFORM, action: 'unlink', baseVersion: 0, status: 'pending',
      platformIds: [PLATFORM_ID],
    })),
  );

  const { ejecutarPasadaDeReparacion } = await import('../services/transition-repair.scheduler');

  // Se cuenta cuántas pasadas están DENTRO al mismo tiempo. El lease serializa
  // entre réplicas, pero dentro de un proceso dos pasadas simultáneas se pisan
  // el trabajo y multiplican la carga sobre Mongo sin ganar nada.
  let dentro = 0;
  let maximoSimultaneo = 0;
  const original = central.FileModel.findOne.bind(central.FileModel);
  (central.FileModel as any).findOne = (...args: any[]) => {
    dentro++;
    maximoSimultaneo = Math.max(maximoSimultaneo, dentro);
    const q = original(...args);
    const leanOriginal = q.lean.bind(q);
    q.lean = async (...a: any[]) => { try { return await leanOriginal(...a); } finally { dentro--; } };
    return q;
  };

  try {
    await Promise.all([
      ejecutarPasadaDeReparacion(),
      ejecutarPasadaDeReparacion(),
      ejecutarPasadaDeReparacion(),
    ]);
  } finally {
    (central.FileModel as any).findOne = original;
  }

  assert.equal(
    maximoSimultaneo, 1,
    'Tres pasadas arrancaron a la vez dentro del mismo proceso. El lease serializa entre réplicas, ' +
    'no acá adentro: dos pasadas simultáneas se pisan el trabajo y multiplican la carga sobre Mongo.',
  );
});

test('P10 — el backoff lleva jitter: dos operaciones que fallan igual no vuelven juntas', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { esperaParaIntento } = await import('../services/transition-repair.service');

  // Sin jitter, todo lo que falló junto vuelve junto -- y vuelve a fallar
  // junto. Es el patrón que convierte una caída breve de Mongo en una tormenta
  // periódica de reintentos sincronizados.
  const esperas = new Set(Array.from({ length: 30 }, () => esperaParaIntento(3)));
  assert.ok(
    esperas.size > 1,
    'Todas las esperas del mismo intento dieron el mismo número. Sin jitter, lo que falló junto ' +
    'vuelve junto y se sincroniza para siempre.',
  );

  // Pero sigue siendo un backoff: crece con los intentos y tiene techo.
  const bajo = Math.min(...Array.from({ length: 30 }, () => esperaParaIntento(1)));
  const alto = Math.min(...Array.from({ length: 30 }, () => esperaParaIntento(5)));
  assert.ok(alto > bajo, 'y sigue creciendo con los intentos');
  assert.ok(Math.max(...Array.from({ length: 30 }, () => esperaParaIntento(50))) <= 3_600_000,
    'con techo, para que un intento 50 no quede programado para el año que viene');
});

test('P10 — las métricas reportan pendientes, fallidas y la edad de la más vieja', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');

  const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await PlatformTransitionOpModel.create([
    { userId: USER_ID, operationId: 'm-vieja', contentId, platform: PLATFORM, action: 'unlink',
      baseVersion: 0, status: 'pending', createdAt: hace2h },
    { userId: USER_ID, operationId: 'm-nueva', contentId, platform: PLATFORM, action: 'unlink',
      baseVersion: 0, status: 'pending' },
    { userId: USER_ID, operationId: 'm-fallida', contentId, platform: PLATFORM, action: 'unlink',
      baseVersion: 0, status: 'failed' },
    { userId: USER_ID, operationId: 'm-hecha', contentId, platform: PLATFORM, action: 'unlink',
      baseVersion: 0, status: 'completed' },
  ]);
  // `timestamps: false` en `create` no alcanza: Mongoose igual sella
  // `createdAt` con ahora. Se fija por el driver crudo, que es lo que de verdad
  // deja el documento como si fuera viejo.
  await PlatformTransitionOpModel.collection.updateOne(
    { operationId: 'm-vieja' }, { $set: { createdAt: hace2h } },
  );

  const { metricasDeReparacion } = await import('../services/transition-repair.service');
  const m = await metricasDeReparacion();

  assert.equal(m.pendientes, 2, 'una cola que no se puede medir no se puede operar');
  assert.equal(m.fallidas, 1, 'y `failed` no se reintenta solo: si nadie lo mira, no existe');
  assert.ok(
    m.edadMaximaMs >= 2 * 60 * 60 * 1000 - 60_000,
    'la edad de la más vieja es la señal que distingue "hay cola" de "hay cola TRABADA"',
  );
});


// ---------------------------------------------------------------------------
// P11 — una cola trabada se ve JUSTAMENTE en los barridos vacíos.
//
// `pasadaConReporte` volvía apenas `revisadas === 0`, antes de consultar las
// métricas. Y ese es exactamente el estado de una cola enferma: una operación
// `failed` no la toma nadie nunca, y una pendiente esperando su backoff tampoco
// -- así que todos los barridos dan cero, y la cola desaparece de la vista
// precisamente cuando hay algo para ver.
//
// Medir es barato; loguear es lo que hay que limitar.
// ---------------------------------------------------------------------------
test('P11 — un barrido sin trabajo igual mide la cola', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');

  // Nada que hacer: una fallida (no la toma nadie) y una pendiente cuyo turno
  // todavía no llegó. Un barrido acá revisa cero.
  await PlatformTransitionOpModel.create([
    { userId: USER_ID, operationId: 'p11-fallida', contentId, platform: PLATFORM, action: 'unlink',
      baseVersion: 0, status: 'failed' },
    { userId: USER_ID, operationId: 'p11-esperando', contentId, platform: PLATFORM, action: 'unlink',
      baseVersion: 0, status: 'pending', nextAttemptAt: new Date(Date.now() + 60 * 60_000) },
  ]);

  const scheduler = await import('../services/transition-repair.scheduler');
  assert.equal((await scheduler.ejecutarPasadaDeReparacion())?.revisadas, 0,
    'precondición: el barrido no tiene nada que hacer');

  // Por el camino REAL: el que corren el arranque, el barrido y el disparo
  // oportunista. Llamar a `observarCola` a mano probaría que la medición
  // funciona, no que alguien la esté llamando -- que es justo lo que fallaba.
  await scheduler.pasadaDeMantenimiento('barrido');
  const m = scheduler.ultimaObservacion()!;
  assert.ok(m, 'la pasada tiene que haber dejado una medición');
  assert.equal(
    m.fallidas, 1,
    'El barrido volvió sin mirar la cola porque no tenía trabajo. Una `failed` no la toma nadie ' +
    'nunca, así que TODOS los barridos van a dar cero -- y la cola desaparece de la vista justo ' +
    'cuando hay algo para ver.',
  );
  assert.equal(m.pendientes, 1);
});


// ===========================================================================
// P12 — MIGRACIÓN DE `discard` (escritorio).
//
// El unlink ya viaja como intención explícita, durable y causal. El descarte
// NO: `updateVideoPlatforms` escribe `platforms_discarded` en SQLite y confía
// en que el push del catálogo lo lleve. Eso es un badge dentro de un array
// dentro de un push masivo -- sin `operationId` (así que un reintento es una
// operación nueva), sin `baseVersion` (así que no tiene precedencia causal), y
// sin nada que lo reintente si el push falla.
//
// Es la misma familia de bugs que motivó todo esto, en la otra acción.
// ===========================================================================

/** El descarte tal como lo dispara Electron: el toggle de badges. */
async function descartarDesdeElectron(localId: number, router: Router, plataformas: string[] = []) {
  const { updateVideoPlatforms } = await import('../../../local-backend/src/controllers/video.controller');
  const { fileRepo } = await import('../../../local-backend/src/db/file.repo');
  const local = fileRepo.findById(localId)!;
  const { res, captured } = fakeRes();
  await updateVideoPlatforms(
    {
      params: { fileId: String(localId) },
      body: { platforms: local.platforms.filter(p => !plataformas.includes(p)), platforms_discarded: plataformas },
      headers: { authorization: AUTH },
    } as any,
    res as any,
  );
  await router.waitIdle();
  return captured;
}

test('P12 — un descarte decidido con la central caída se entrega cuando vuelve', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await descartarDesdeElectron(local.id, router, [PLATFORM]);

    // La intención tiene que estar guardada, igual que la de desvincular.
    const encoladas = await pendientesEnOutbox(contentId);
    assert.equal(
      encoladas.length, 1,
      'El descarte no dejó ninguna intención encolada: viaja como un badge dentro del push del ' +
      'catálogo, sin operationId, sin baseVersion y sin nada que lo reintente si el push falla.',
    );
    assert.equal(encoladas[0].action, 'discard');
    assert.equal(encoladas[0].platform, PLATFORM);
    assert.ok(encoladas[0].operation_id);

    // Vuelve la central y se entrega.
    router.cortar = null;
    const { entregadas } = await flushOutbox();
    assert.equal(entregadas, 1);

    const foto = await fotoDelEstado(contentId);
    assert.ok(foto.files.discarded.includes(PLATFORM), 'el descarte llega a files');
    assert.ok(!foto.files.platforms.includes(PLATFORM), 'y saca la plataforma de publicadas');
    assert.ok(foto.backupFiles.discarded.includes(PLATFORM), 'y a backup_files');
    assert.ok(foto.remote.discarded.includes(PLATFORM), 'y a Nube');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

test('P12 — el descarte declara operationId y baseVersion, y es estable entre reintentos', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await descartarDesdeElectron(local.id, router, [PLATFORM]);

    const fila = (await pendientesEnOutbox(contentId))[0];
    const opId = fila.operation_id;
    const base = Number(fila.base_version);
    assert.ok(Number.isInteger(base) && base >= 0, 'baseVersion tiene que ser la revisión que se vio');

    // Dos reintentos fallidos más. La operación NO cambia de identidad: si
    // cambiara, la central no podría deduplicar una respuesta perdida.
    await flushOutbox();
    await flushOutbox();
    const trasReintentos = (await pendientesEnOutbox(contentId))[0];
    assert.equal(trasReintentos.operation_id, opId, 'el operationId tiene que ser estable');
    assert.equal(Number(trasReintentos.base_version), base, 'y la base también');
    assert.ok(trasReintentos.attempts >= 2, 'con los intentos contados');

    // Y al entregar, lo que sale por la ruta nueva declara las dos cosas.
    router.cortar = null;
    router.cuerpos.length = 0;
    await flushOutbox();
    const enviado = router.cuerpos.find((c: any) => c.path === '/api/sync/platform-transition');
    assert.ok(enviado, 'el descarte tiene que salir por el contrato explícito, no como badge');
    assert.equal(enviado.body.action, 'discard');
    assert.equal(enviado.body.operationId, opId);
    assert.equal(enviado.body.baseVersion, base);
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

test('P12 — si no se puede encolar el descarte, el badge local tampoco cambia', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    const { transitionOutboxRepo } = await import('../../../local-backend/src/db/transition-outbox.repo');
    const originalEnqueue = transitionOutboxRepo.enqueue;
    (transitionOutboxRepo as any).enqueue = () => { throw new Error('caída simulada al encolar'); };

    let captured: any;
    try {
      captured = await descartarDesdeElectron(local.id, router, [PLATFORM]);
    } catch { /* que reviente o que devuelva 500: importa qué quedó escrito */ }
    finally {
      (transitionOutboxRepo as any).enqueue = originalEnqueue;
    }

    const foto = await fotoDelEstado(contentId);
    assert.ok(
      !foto.sqlite.discarded.includes(PLATFORM),
      'El badge local se marcó como descartado aunque la intención no se pudo encolar: queda un ' +
      'cambio local que nada va a propagar nunca.',
    );
    assert.deepEqual(await pendientesEnOutbox(contentId), [], 'no quedó nada encolado, que es la premisa');
    assert.notEqual(captured?.status, 200, 'y el cliente no puede recibir un OK');
  } finally {
    router.restore();
  }
});


test('P12 — repetir el mismo descarte no genera una operación nueva', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);

    await descartarDesdeElectron(local.id, router, [PLATFORM]);
    const primera = await pendientesEnOutbox(contentId);
    assert.equal(primera.length, 1, 'precondición: el primer descarte encola una operación');

    // La UI vuelve a mandar el mismo estado (un re-render, un doble clic, un
    // guardado repetido). No hay decisión NUEVA, así que no hay operación nueva.
    await descartarDesdeElectron(local.id, router, [PLATFORM]);
    const despues = await pendientesEnOutbox(contentId);
    assert.equal(
      despues.length, 1,
      'Encolar por el ESTADO en vez de por el cambio genera una operación por cada guardado. Cada ' +
      'una con su propia baseVersion, así que todas menos la primera nacen destinadas al conflicto.',
    );
    assert.equal(despues[0].operation_id, primera[0].operation_id);
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});


// ===========================================================================
// P13 — la OTRA dirección del toggle: `discarded` → `pending`.
//
// La migración anterior encola solo lo que ENTRA en `platforms_discarded`.
// Cuando el usuario saca una plataforma de descartadas, desaparece del array y
// no se genera ninguna transición: el cambio viaja otra vez como badge dentro
// del push, que es justo lo que estábamos retirando.
//
// Y es peor que en el otro sentido, porque el snapshot del push puede sacarla
// de los arrays pero NO toca `platform_states` ni mueve `platform_rev`: la
// central se queda con `platform_states.instagram = discarded` mientras el
// escritorio muestra pendiente. Divergencia estable, no transitoria.
//
// LAS CUATRO REGLAS DEL DELTA. Un toggle de badges manda ESTADO, no acciones,
// así que hay que derivar qué pasó -- y las cuatro combinaciones significan
// cosas distintas:
//
//   entra en discarded                        -> `discard`
//   sale de discarded y NO entra en platforms -> `unlink` (queda ausente)
//   sale de discarded Y entra en platforms    -> publicación/confirmación, que
//                                                tiene su propio camino: mandar
//                                                `unlink` acá sería borrar
//                                                justo lo que se acaba de
//                                                afirmar
//   `platforms_discarded` no vino en el request -> no inferir NADA: un request
//                                                parcial no es una decisión de
//                                                vaciar el array
// ===========================================================================

test('P13 — sacar una plataforma de descartadas genera un `unlink` durable', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();

  // Estado inicial: descartada en los dos lados.
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await descartarDesdeElectron(local.id, router, [PLATFORM]);
    router.cortar = null;
    await flushOutbox();
    const inicial = await fotoDelEstado(contentId);
    assert.ok(inicial.files.discarded.includes(PLATFORM), 'precondición: arranca descartada');
    assert.equal((inicial.files.states as any[]).find(e => e.platform === PLATFORM)?.state, 'discarded');

    // Y ahora el usuario la vuelve a pendiente, con la central caída.
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await descartarDesdeElectron(local.id, router, []);

    const encoladas = (await pendientesEnOutbox(contentId)).filter(e => e.status === 'pending');
    assert.equal(
      encoladas.length, 1,
      'Sacar una plataforma de descartadas no dejó ninguna intención. El cambio vuelve a viajar ' +
      'como badge dentro del push -- y ese push saca la plataforma de los arrays pero no toca ' +
      '`platform_states` ni mueve la revisión, así que la central se queda en `discarded` mientras ' +
      'el escritorio muestra pendiente.',
    );
    assert.equal(
      encoladas[0].action, 'unlink',
      'y la acción es `unlink`: "pendiente" es la AUSENCIA de la plataforma, que es exactamente lo ' +
      'que unlink deja',
    );
    const opId = encoladas[0].operation_id;
    const base = Number(encoladas[0].base_version);
    assert.ok(Number.isInteger(base) && base >= 0);

    // Estable entre reintentos.
    await flushOutbox();
    const tras = (await pendientesEnOutbox(contentId)).find(e => e.operation_id === opId)!;
    assert.equal(Number(tras.base_version), base, 'la base no puede moverse entre reintentos');

    // Vuelve la central y converge a pendiente en todas partes.
    router.cortar = null;
    await flushOutbox();

    const foto = await fotoDelEstado(contentId);
    assert.ok(!foto.files.discarded.includes(PLATFORM), 'files: ya no descartada');
    assert.ok(!foto.files.platforms.includes(PLATFORM), 'files: tampoco publicada -- pendiente es la ausencia');
    assert.equal(
      (foto.files.states as any[]).find(e => e.platform === PLATFORM), undefined,
      'y `platform_states` tiene que soltarla: si queda en `discarded`, la central sigue diciendo ' +
      'descartada aunque los arrays digan otra cosa',
    );
    assert.ok(!foto.backupFiles.discarded.includes(PLATFORM), 'backup_files converge');
    assert.ok(!foto.remote.discarded.includes(PLATFORM), 'y Nube también');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

test('P13 — repetir el mismo estado pendiente no genera otra operación', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await descartarDesdeElectron(local.id, router, [PLATFORM]);
    await descartarDesdeElectron(local.id, router, []);
    const primera = await pendientesEnOutbox(contentId);
    assert.equal(primera.length, 2, 'precondición: un discard y un unlink');

    // El mismo estado otra vez: no hay decisión nueva.
    await descartarDesdeElectron(local.id, router, []);
    assert.equal(
      (await pendientesEnOutbox(contentId)).length, 2,
      'Derivar del ESTADO en vez del CAMBIO genera una operación por cada guardado, cada una con ' +
      'su propia baseVersion -- todas menos la primera nacidas destinadas al conflicto.',
    );
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

test('P13 — sacar de descartadas Y publicar a la vez NO manda un unlink', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await descartarDesdeElectron(local.id, router, [PLATFORM]);
    const trasDescartar = (await pendientesEnOutbox(contentId)).length;

    // El usuario marca la plataforma como PUBLICADA: sale de descartadas y
    // entra en platforms en el mismo movimiento.
    const { updateVideoPlatforms } = await import('../../../local-backend/src/controllers/video.controller');
    const { res } = fakeRes();
    await updateVideoPlatforms(
      { params: { fileId: String(local.id) }, body: { platforms: [PLATFORM], platforms_discarded: [] },
        headers: { authorization: AUTH } } as any,
      res as any,
    );
    await router.waitIdle();

    const todas = await pendientesEnOutbox(contentId);
    assert.equal(
      todas.length, trasDescartar,
      'Salir de descartadas ENTRANDO en publicadas es una confirmación de publicación, no una ' +
      'desvinculación. Mandar `unlink` acá borraría exactamente lo que el usuario acaba de afirmar.',
    );
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});

test('P13 — un request sin `platforms_discarded` no infiere eliminaciones', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { local, contentId } = await sembrarConfirmado();
  const router = routeToCentral();
  try {
    router.cortar = (m, p) => (p === '/api/sync/platform-transition' ? 'red' : null);
    await descartarDesdeElectron(local.id, router, [PLATFORM]);
    const trasDescartar = (await pendientesEnOutbox(contentId)).length;

    // Un request que solo toca `platforms`. No dice nada sobre descartadas, así
    // que no decidió nada sobre ellas.
    const { updateVideoPlatforms } = await import('../../../local-backend/src/controllers/video.controller');
    const { res } = fakeRes();
    await updateVideoPlatforms(
      { params: { fileId: String(local.id) }, body: { platforms: [] },
        headers: { authorization: AUTH } } as any,
      res as any,
    );
    await router.waitIdle();

    assert.equal(
      (await pendientesEnOutbox(contentId)).length, trasDescartar,
      'Un request parcial no es una decisión de vaciar el array. Inferir eliminaciones de lo que ' +
      'no vino convierte cada guardado parcial en desvinculaciones que nadie pidió.',
    );
    const { fileRepo } = await import('../../../local-backend/src/db/file.repo');
    assert.ok(fileRepo.findById(local.id)!.platforms_discarded.includes(PLATFORM as any),
      'y el descarte local sigue donde estaba');
    assert.deepEqual(router.unknown, []);
  } finally {
    router.restore();
  }
});


// ===========================================================================
// BOOTSTRAP DE IDENTIDAD — `POST /api/sync/resolve-identity`.
//
// Un cliente que importó un video localmente no tiene `content_id`: esa
// identidad la emite la central. Sin ella no puede encolar ninguna transición,
// porque no hay bajo qué identidad declararla -- y derivarla del nombre es
// exactamente lo que esa clave vino a impedir.
//
// POR QUÉ UNA OPERACIÓN APARTE, y no ampliar `file-platforms` para que devuelva
// la identidad: ese endpoint APLICA UN SNAPSHOT primero, sin base causal.
// Devolver la identidad después no corrige esa primera escritura insegura --
// dejaría intacto justo el hueco que venimos cerrando.
//
// La resolución no escribe estado: busca o crea, asegura la identidad, y
// devuelve identidad + estado + revisiones DEL MISMO DOCUMENTO.
// ===========================================================================

async function resolverIdentidad(body: any) {
  const { res, captured } = fakeRes();
  await central.resolveIdentityEndpoint(
    { user: USER, headers: { authorization: AUTH }, params: {}, query: {}, body } as any,
    res as any,
  );
  return captured;
}

test('BOOTSTRAP — resolver dos veces devuelve siempre la misma identidad', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const primera = await resolverIdentidad({
    fileName: 'video nuevo del telefono.mp4', deviceId: 'iphone-1', clientFileId: 'local-1',
  });
  assert.equal(primera.status, 200);
  const cid = primera.body?.contentId;
  assert.match(
    String(cid), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'la central emite un UUID: es ella la autoridad de la identidad, no el cliente',
  );

  const segunda = await resolverIdentidad({
    fileName: 'video nuevo del telefono.mp4', deviceId: 'iphone-1', clientFileId: 'local-1',
  });
  assert.equal(
    segunda.body?.contentId, cid,
    'Resolver es idempotente. Si cada llamada emitiera una identidad nueva, dos acciones del mismo ' +
    'teléfono sobre el mismo archivo declararían identidades distintas y la central las trataría ' +
    'como dos videos.',
  );
  assert.equal(
    await central.FileModel.countDocuments({ userId: USER_ID, file_name: 'video nuevo del telefono.mp4' }), 1,
    'y no puede crear un segundo documento',
  );
});

test('BOOTSTRAP — un archivo viejo sin content_id recibe uno, sin duplicarlo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Un documento de antes de que existiera `content_id`.
  await central.FileModel.create({
    userId: USER_ID, file_name: 'viejo sin identidad.mp4', file_path: 'viejo sin identidad.mp4',
    status: 'PENDIENTE', platforms: [], platforms_discarded: [],
  });

  // El backfill NO pasa por `resolve-identity`: ese endpoint no busca por
  // nombre a propósito, así que nunca se topa con un documento legado. Pasa por
  // `resolveOrCreateFile`, que sí resuelve por nombre -- una publicación desde
  // el celular de un archivo que el escritorio ya tenía.
  //
  // Dos a la vez: es el caso real de un reintento que llega mientras el primero
  // sigue en vuelo.
  const { resolveOrCreateFile } = await import('./backup.controller');
  const [a, b] = await Promise.all([
    resolveOrCreateFile(USER_ID, { fileName: 'viejo sin identidad.mp4' }),
    resolveOrCreateFile(USER_ID, { fileName: 'viejo sin identidad.mp4' }),
  ]);

  assert.ok(a?.content_id, 'el documento legado tiene que salir con identidad');
  assert.equal(
    String(a?.content_id), String(b?.content_id),
    'Dos resoluciones concurrentes no pueden asignar identidades distintas al mismo documento: la ' +
    'asignación tiene que ser atómica, no leer-decidir-escribir.',
  );
  assert.equal(
    await central.FileModel.countDocuments({ userId: USER_ID, file_name: 'viejo sin identidad.mp4' }), 1,
    'y sin duplicar el documento',
  );
});

test('BOOTSTRAP — identidad, estado y revisiones salen del MISMO documento', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // Se mueve la revisión con una transición real, para que haya algo que leer.
  const { applyPlatformTransition } = await import('../services/platform-transition.service');
  await applyPlatformTransition(USER_ID, {
    contentId, platform: PLATFORM as any, action: 'discard',
    operationId: 'bootstrap-mueve-revision', baseVersion: 0,
  });
  const revReal = await revisionDe(contentId);

  const r = await resolverIdentidad({
    fileName: 'video integral.mp4', contentId, deviceId: 'iphone-1', clientFileId: 'local-2',
  });

  assert.equal(r.body?.contentId, contentId);
  assert.deepEqual(r.body?.platformsDiscarded, [PLATFORM], 'el estado, del mismo documento');
  assert.equal(
    (r.body?.platformRev ?? {})[PLATFORM], revReal,
    'y la revisión también. Que vengan juntas es el punto: pedirlas por separado deja la ventana ' +
    'en la que el teléfono se queda con el estado de antes y la revisión de después.',
  );
  assert.ok(
    Array.isArray(r.body?.platformStates),
    'con `platform_states`, que es lo que distingue publicado-con-link de badge manual',
  );
});

test('BOOTSTRAP — resolver NO aplica ningún estado', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const antes = await fotoDelEstado(contentId);
  const revAntes = await revisionDe(contentId);

  await resolverIdentidad({
    fileName: 'video integral.mp4', contentId, deviceId: 'iphone-1', clientFileId: 'local-3',
    // Un cliente podría mandar su estado local; la resolución tiene que
    // ignorarlo.
    platforms: [], platformsDiscarded: ['tiktok', 'youtube'],
  });

  const despues = await fotoDelEstado(contentId);
  assert.deepEqual(
    despues.files.platforms, antes.files.platforms,
    'Resolver es una LECTURA con efecto secundario de identidad, no un escritor de estado. Si ' +
    'aplicara lo que el cliente manda, sería otro snapshot sin base causal -- exactamente lo que ' +
    'esta operación existe para evitar.',
  );
  assert.deepEqual(despues.files.discarded, antes.files.discarded);
  assert.equal(await revisionDe(contentId), revAntes, 'y no mueve la revisión');
});


// ---------------------------------------------------------------------------
// EL NOMBRE NO ES IDENTIDAD.
//
// `ImportUseCase` de iOS marca `isDuplicate` pero CREA el archivo igual, y su
// dedup mira `(fileName, duracionSegundos, formato)`. O sea que dos videos
// DISTINTOS con el mismo nombre coexisten en el teléfono como dos
// `FileEntity`.
//
// Resolver por nombre les daría el MISMO `content_id`, y a partir de ahí toda
// transición sobre uno afectaría al otro. Peor: el caso de idempotencia por
// nombre consolidaría esa colisión como si fuera lo correcto.
//
// El vínculo determinístico es `(userId, deviceId, clientFileId)`. El nombre
// queda como metadata.
// ---------------------------------------------------------------------------

test('BOOTSTRAP — dos archivos distintos con el mismo nombre reciben identidades distintas', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const a = await resolverIdentidad({
    fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-A',
  });
  const b = await resolverIdentidad({
    fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-B',
  });

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(
    a.body?.contentId, b.body?.contentId,
    'Son dos videos distintos que casualmente comparten nombre. Darles la misma identidad hace que ' +
    'toda transición sobre uno afecte al otro. Sin vínculo determinístico es más seguro crear dos ' +
    'identidades reconciliables después que fusionar dos videos.',
  );
});

test('BOOTSTRAP — el mismo vínculo del cliente devuelve siempre la misma identidad', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const primera = await resolverIdentidad({
    fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-A',
  });
  // El mismo archivo, después de que el usuario lo renombró en el teléfono.
  const segunda = await resolverIdentidad({
    fileName: 'clip renombrado.mp4', deviceId: 'iphone-1', clientFileId: 'local-A',
  });

  assert.equal(
    segunda.body?.contentId, primera.body?.contentId,
    'El vínculo es (deviceId, clientFileId), no el nombre: renombrar un archivo en el teléfono no ' +
    'puede cambiar su identidad ni inaugurar una nueva.',
  );
});

test('BOOTSTRAP — un contentId ya conocido es la identidad canónica, no se crea otra', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const antes = await central.FileModel.countDocuments({ userId: USER_ID });

  const r = await resolverIdentidad({
    fileName: 'video integral.mp4', contentId, deviceId: 'iphone-1', clientFileId: 'local-C',
  });

  assert.equal(r.body?.contentId, contentId, 'el vínculo apunta a la identidad que ya existía');
  assert.equal(
    await central.FileModel.countDocuments({ userId: USER_ID }), antes,
    'y no se crea un documento nuevo: el cliente trajo la identidad canónica',
  );
});

test('BOOTSTRAP — se rechaza lo que no permite construir un vínculo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const sinVinculo = await resolverIdentidad({ fileName: 'clip.mp4' });
  assert.equal(
    sinVinculo.status, 400,
    'Sin `deviceId`/`clientFileId` la única forma de resolver sería por nombre, que es justo lo ' +
    'que no puede hacerse.',
  );

  const idInvalido = await resolverIdentidad({
    fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-A', contentId: 'no-es-un-uuid',
  });
  assert.equal(
    idInvalido.status, 400,
    'Un `contentId` que no es UUID no puede aceptarse: quedaría persistido como identidad y todo ' +
    'lo que dependa del índice único se rompería en silencio.',
  );
});


test('BOOTSTRAP — dos resoluciones simultáneas del mismo vínculo dan la misma identidad', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Sin `contentId` previo: las dos van por el camino de crear identidad nueva,
  // que es donde una escritura no idempotente del vínculo pisaría a la otra.
  const [a, b] = await Promise.all([
    resolverIdentidad({ fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-A' }),
    resolverIdentidad({ fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-A' }),
  ]);

  assert.equal(
    a.body?.contentId, b.body?.contentId,
    'Es el MISMO vínculo: dos identidades distintas harían que el teléfono creyera que su archivo ' +
    'cambió de identidad entre dos llamadas, y toda transición encolada con la anterior quedaría ' +
    'huérfana.',
  );
  const { FileIdentityBindingModel } = await import('../models/file-identity-binding.model');
  assert.equal(
    await FileIdentityBindingModel.countDocuments({ userId: USER_ID, clientFileId: 'local-A' }), 1,
    'y un solo vínculo persistido',
  );
});

test('BOOTSTRAP — si la relectura final no encuentra el documento, no responde 200', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Se rompe la relectura final: el documento "desaparece" entre que se asigna
  // la identidad y que se lee el estado.
  const original = central.FileModel.findOne.bind(central.FileModel);
  let llamadas = 0;
  (central.FileModel as any).findOne = (...args: any[]) => {
    llamadas++;
    const q = original(...args);
    // En este camino (identidad nueva) la ÚNICA llamada a FileModel.findOne es
    // la relectura final del estado.
    if (llamadas >= 1) {
      const leanOriginal = q.lean.bind(q);
      q.lean = async () => { void leanOriginal; return null; };
    }
    return q;
  };

  let r: any;
  try {
    r = await resolverIdentidad({ fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-Z' });
  } finally {
    (central.FileModel as any).findOne = original;
  }

  assert.notEqual(
    r.status, 200,
    'Un 200 sin estado haría que el teléfono creyera que ya tiene identidad Y revisiones -- y sin ' +
    'revisiones observadas encolaría con una base inventada.',
  );
});


test('BOOTSTRAP — una caída entre la reserva y la creación del documento se reanuda', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Se rompe la creación del documento, DESPUÉS de que el vínculo ya reservó
  // la identidad.
  const original = central.FileModel.findOneAndUpdate.bind(central.FileModel);
  let rota = false;
  (central.FileModel as any).findOneAndUpdate = (...args: any[]) => {
    if (!rota) { rota = true; throw new Error('caída simulada tras reservar'); }
    return original(...args);
  };

  let primera: any;
  try {
    primera = await resolverIdentidad({ fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-R' });
  } finally {
    (central.FileModel as any).findOneAndUpdate = original;
  }
  assert.ok(rota, 'precondición: se cortó donde se quería');
  assert.notEqual(primera.status, 200, 'la primera llamada no puede decir que salió bien');

  // El vínculo quedó reservado, sin documento.
  const { FileIdentityBindingModel } = await import('../models/file-identity-binding.model');
  const reservado = await FileIdentityBindingModel
    .findOne({ userId: USER_ID, deviceId: 'iphone-1', clientFileId: 'local-R' }).lean();
  assert.ok(reservado?.contentId, 'precondición: la identidad quedó reservada');
  assert.equal(
    await central.FileModel.countDocuments({ userId: USER_ID, content_id: reservado!.contentId }), 0,
    'precondición: y el documento no llegó a crearse',
  );

  // El reintento recupera la MISMA identidad y termina el trabajo.
  const segunda = await resolverIdentidad({ fileName: 'clip.mp4', deviceId: 'iphone-1', clientFileId: 'local-R' });
  assert.equal(segunda.status, 200);
  assert.equal(
    segunda.body?.contentId, reservado!.contentId,
    'Reservando el vínculo PRIMERO, una caída no puede producir una identidad nueva: el reintento ' +
    'recupera la que ya existía y solo le falta terminar de crear el documento. Al revés -- crear ' +
    'el documento y después vincular -- la caída dejaba un huérfano y el reintento inauguraba otra.',
  );
  assert.equal(
    await central.FileModel.countDocuments({ userId: USER_ID, content_id: reservado!.contentId }), 1,
    'y el documento queda creado exactamente una vez',
  );
});


test('BOOTSTRAP — si el índice crítico no se puede crear, el arranque falla', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { asegurarIndicesCriticos } = await import('../services/indices-criticos.service');
  const { FileIdentityBindingModel } = await import('../models/file-identity-binding.model');

  // Con el índice sano, el gate pasa.
  await asegurarIndicesCriticos();

  const original = FileIdentityBindingModel.createIndexes.bind(FileIdentityBindingModel);
  (FileIdentityBindingModel as any).createIndexes = async () => { throw new Error('Mongo dijo que no'); };
  try {
    await assert.rejects(
      () => asegurarIndicesCriticos(),
      /índice crítico/,
      'Arrancar sin ese índice deja al server atendiendo requests que pueden reservar dos ' +
      'identidades para el mismo archivo. Fallar el arranque se ve; identidades duplicadas, no.',
    );
  } finally {
    (FileIdentityBindingModel as any).createIndexes = original;
  }
});


// ---------------------------------------------------------------------------
// EL BADGE NO ALCANZA: hace falta la identidad del VÍNCULO.
//
// Este caso es el peligroso:
//
//     el teléfono observó Instagram confirmado con el link A
//     la central tiene  Instagram confirmado con el link B
//
// Los dos se ven igual desde el badge -- `published(hasLink: true)` -- así que
// una comparación por estado los daría por coincidentes, el bootstrap tomaría
// la revisión actual, y el `unlink` que el usuario decidió sobre A borraría B,
// que nunca vio.
//
// Por eso la resolución devuelve el `platformId` vinculado. Y solo lo declara
// COHERENTE cuando puede demostrarlo: el vínculo lleva su propia `linkVersion`,
// y si no coincide con la revisión de esa plataforma no hay forma de afirmar
// que describen el mismo momento. Ahí el cliente tiene que tratar una intención
// que elimina el vínculo como conflicto conservador.
// ---------------------------------------------------------------------------

test('BOOTSTRAP — la resolución devuelve el platformId vinculado, no solo el badge', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // El vínculo sellado con la revisión vigente: coherente.
  await central.PlatformVideoModel.updateOne(
    { userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID },
    { $set: { linkVersion: await revisionDe(contentId) } },
  );

  const r = await resolverIdentidad({
    fileName: 'video integral.mp4', contentId, deviceId: 'iphone-1', clientFileId: 'local-V',
  });

  const links = (r.body?.platformLinks ?? []) as any[];
  const ig = links.find(l => l.platform === PLATFORM);
  assert.ok(
    ig,
    'Sin el `platformId` el cliente no puede distinguir "confirmado con el link que yo vi" de ' +
    '"confirmado con otro link": los dos son `published(hasLink: true)`.',
  );
  assert.equal(ig.platformId, PLATFORM_ID);
  assert.equal(ig.coherente, true, 'la linkVersion coincide con la revisión de la plataforma');
});

test('BOOTSTRAP — un vínculo que no se puede demostrar coherente se declara así', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // El vínculo quedó sellado con OTRA revisión: puede ser de antes o de un
  // camino que no selló. No hay forma de afirmar que describe el mismo momento
  // que `platform_rev`.
  await central.PlatformVideoModel.updateOne(
    { userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID },
    { $set: { linkVersion: 99 } },
  );

  const r = await resolverIdentidad({
    fileName: 'video integral.mp4', contentId, deviceId: 'iphone-1', clientFileId: 'local-W',
  });

  const ig = ((r.body?.platformLinks ?? []) as any[]).find(l => l.platform === PLATFORM);
  assert.ok(ig, 'el vínculo se informa igual');
  assert.equal(
    ig.coherente, false,
    'Declararlo coherente sin poder demostrarlo es peor que no informarlo: el cliente compararía ' +
    'contra un vínculo que quizá no corresponde a esa revisión, y borraría algo que nunca vio.',
  );
});

test('BOOTSTRAP — una plataforma sin vínculo no inventa uno', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const r = await resolverIdentidad({
    fileName: 'video integral.mp4', contentId, deviceId: 'iphone-1', clientFileId: 'local-X',
  });

  const links = (r.body?.platformLinks ?? []) as any[];
  assert.equal(
    links.filter(l => l.platform === 'youtube').length, 0,
    'YouTube no tiene vínculo: informar uno vacío haría que el cliente creyera que hay algo que ' +
    'comparar donde no hay nada.',
  );
});


test('BOOTSTRAP — con dos vínculos vivos de la misma plataforma, ninguno se declara coherente', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const file = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  const rev = await revisionDe(contentId);

  // El primero, sellado con la revisión vigente: por sí solo sería coherente.
  await central.PlatformVideoModel.updateOne(
    { userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID },
    { $set: { linkVersion: rev } },
  );
  // Y un SEGUNDO vínculo vivo de la misma plataforma para el mismo archivo.
  // No debería existir -- applyPlatformPublish desvincula los otros -- pero eso
  // es best-effort y hay más de un escritor.
  await central.PlatformVideoModel.create({
    userId: USER_ID, platform: PLATFORM, platformId: '17222222222222222',
    platformUrl: 'https://www.instagram.com/reel/GGGGGGGGGGG/',
    linkedFileId: file!._id, matchStatus: 'manual', linkVersion: rev,
    publishedAt: new Date('2026-09-05T10:00:00.000Z'),
  });

  const r = await resolverIdentidad({
    fileName: 'video integral.mp4', contentId, deviceId: 'iphone-1', clientFileId: 'local-AMB',
  });

  const deInstagram = ((r.body?.platformLinks ?? []) as any[]).filter(l => l.platform === PLATFORM);
  assert.ok(
    deInstagram.length <= 1,
    'Devolver dos entradas de la misma plataforma deja que el cliente elija una por el orden de ' +
    'Mongo, y esa elección arbitraria sería una coherencia falsa.',
  );
  if (deInstagram.length === 1) {
    assert.equal(
      deInstagram[0].coherente, false,
      'Con dos vínculos vivos no se puede afirmar cuál es EL vínculo, así que no hay coherencia ' +
      'que demostrar -- aunque los dos estén sellados con la revisión vigente.',
    );
    assert.equal(deInstagram[0].platformId, null,
      'y no puede ofrecer un platformId: sería el elegido arbitrariamente');
  }
});

// ---------------------------------------------------------------------------
// P0 — la revisión del VÍNCULO no es la revisión del archivo.
//
// `link_version` en el espejo (y `linkVersion` en platformvideos) se sellaban
// con `files.platform_rev`: la revisión de ESTADO del archivo. Sirve para
// ordenar cambios dentro de un mismo archivo, y es lo que tiene que seguir
// siendo el CAS de ese estado. Pero un vínculo puede cambiar de archivo, y ahí
// esos números dejan de ser comparables: soltarlo de A en su revisión 4 y
// publicarlo después sobre B -- cuya revisión empieza de cero -- hace que la
// central, y cualquier teléfono que ya aplicó la lápida, rechacen el 1 de B
// por no superar el 4 de A.
//
// Hace falta una revisión propia del vínculo `(userId, platform, platformId)`,
// emitida por el servidor y monotónica sin importar de qué archivo venga.
// ---------------------------------------------------------------------------

async function espejoDe(platformId: string) {
  return central.BackupPlatformVideoModel
    .findOne({ userId: USER_ID, platform: PLATFORM, platform_id: platformId }).lean();
}

/** Lo que reciben los teléfonos y las PCs: el GET real del espejo. */
async function filasDelPull(): Promise<any[]> {
  const { res, captured } = fakeRes();
  await central.getBackupPlatformVideos(
    { user: USER, headers: { authorization: AUTH }, params: {}, query: {}, body: {} } as any, res as any,
  );
  return captured.body?.videos ?? [];
}

test('P0 — un vínculo reasignado a otro archivo supera su lápida aunque ese archivo tenga una revisión menor', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const transicion = async (action: string, op: string) => {
    const r = await postTransicion({
      contentId, platform: PLATFORM, action, operationId: op, baseVersion: await revisionDe(contentId),
    });
    assert.equal(r.status, 200, `precondición: ${op} se aplicó`);
  };

  // A acumula revisiones con decisiones reales del usuario...
  await transicion('discard', 'p0-lv-1');
  await transicion('unlink', 'p0-lv-2');
  await central.applyPlatformPublish(USER_ID, {
    contentId, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-09T10:00:00.000Z'),
  });
  // ...y la publicación se suelta de A.
  await transicion('unlink', 'p0-lv-3');
  const lapida = await espejoDe(PLATFORM_ID);
  assert.equal(lapida?.link_state, 'unlinked', 'precondición: la lápida de A está puesta');

  // Después, la MISMA publicación se vincula legítimamente a otro archivo.
  const OTRO = '33333333-4444-5555-6666-777777777777';
  await central.applyPlatformPublish(USER_ID, {
    contentId: OTRO, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
  });
  const otro = await central.FileModel.findOne({ userId: USER_ID, content_id: OTRO }).lean();
  assert.ok(otro, 'precondición: el otro archivo existe');
  assert.ok(
    (await revisionDe(OTRO)) < (await revisionDe(contentId)),
    'precondición: el otro archivo tiene una revisión MENOR que la de A',
  );

  const pv = await central.PlatformVideoModel
    .findOne({ userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID }).lean();
  assert.equal(
    String(pv?.linkedFileId), String(otro?._id),
    'La central rechazó la reasignación: el guard de platformvideos comparó la revisión del OTRO ' +
    'archivo contra la que dejó la lápida de A, que es de otro dominio. El E11000 del upsert se ' +
    'traga en silencio y el vínculo queda suelto para siempre.',
  );

  const fila = (await filasDelPull()).find((v: any) => v.platform === PLATFORM && v.platform_id === PLATFORM_ID);
  assert.deepEqual(
    [fila?.link_state, fila?.content_id], ['linked', OTRO],
    'y el espejo que leen los teléfonos y las PCs tampoco lo reasigna',
  );
  assert.ok(
    (fila?.link_version ?? 0) > (lapida?.link_version ?? 0),
    `con una revisión MAYOR que la de la lápida (${fila?.link_version} contra ${lapida?.link_version}): ` +
    'si no, un dispositivo que ya aplicó la lápida no lo revive nunca',
  );
});

test('P0 — una PC que vuelve a vincular después de la lápida deja una revisión mayor', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-push',
    baseVersion: await revisionDe(contentId),
  });
  assert.equal(r.status, 200, 'precondición: el unlink se aplicó');
  const lapida = await espejoDe(PLATFORM_ID);
  assert.equal(lapida?.link_state, 'unlinked', 'precondición: la lápida está puesta');

  // Una PC volvió a vincular DESPUÉS del unlink, y lo manda en su push periódico.
  const despues = new Date(new Date(lapida.link_updated_at).getTime() + 60_000);
  const { res, captured } = fakeRes();
  await central.bulkUpsertBackupPlatformVideos(
    {
      user: USER, headers: { authorization: AUTH }, params: {}, query: {},
      body: { videos: [{
        platform: PLATFORM, platform_id: PLATFORM_ID, platform_url: PLATFORM_URL,
        content_id: contentId, file_name: 'video integral.mp4', match_status: 'manual',
        local_updated_at: despues.toISOString(),
      }] },
    } as any,
    res as any,
  );
  assert.equal(captured.body?.updated, 1, 'precondición: el push es posterior a la lápida, así que gana');

  const fila = await espejoDe(PLATFORM_ID);
  assert.equal(fila?.link_state, 'linked', 'precondición: el vínculo revivió');
  assert.ok(
    (fila?.link_version ?? 0) > (lapida?.link_version ?? 0),
    `El push revivió el vínculo sin mover su revisión (${fila?.link_version} contra ${lapida?.link_version}). ` +
    'Un teléfono que ya aplicó la lápida la compara y la ve igual: no lo revive nunca, y queda distinto ' +
    'de las PCs.',
  );
});

test('P0 — corregir el link de un archivo le deja la lápida al anterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const NUEVO = '17888888888888888';
  await central.applyPlatformPublish(USER_ID, {
    contentId, platform: PLATFORM, platformId: NUEVO, platformUrl: 'https://www.instagram.com/reel/BBBBBBBBBBB/',
    fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-09T10:00:00.000Z'),
  });
  const viejo = await central.PlatformVideoModel
    .findOne({ userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID }).lean();
  assert.ok(!viejo?.linkedFileId, 'precondición: platformvideos ya soltó el link anterior');

  const vivos = (await filasDelPull())
    .filter((v: any) => v.platform === PLATFORM && v.content_id === contentId && v.link_state !== 'unlinked')
    .map((v: any) => v.platform_id);
  assert.deepEqual(
    vivos, [NUEVO],
    'Corregir el link suelta el anterior en platformvideos pero no en el espejo: los dispositivos ' +
    'reciben DOS vínculos vivos para el mismo archivo y plataforma. Un pull que trate bien esa ' +
    'ambigüedad termina sin mostrar ninguno -- por una corrección normal del usuario.',
  );
  assert.ok(
    ((await espejoDe(PLATFORM_ID))?.link_version ?? 0) > 0,
    'y la lápida del anterior lleva su revisión, para que un dispositivo pueda ordenarla',
  );
});

test('P0 — reparar un archivo no le pone la lápida a un vínculo que ya es de otro', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar';
  // Queda una operación de A pendiente y superada, con este vínculo en su alcance.
  await transicionSuperadaAMitad(contentId, op);

  // Después el usuario suelta el vínculo de A de verdad...
  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-reparar-2',
    baseVersion: await revisionDe(contentId),
  });
  assert.equal(r.status, 200, 'precondición: el unlink se aplicó');
  // ...y lo publica sobre otro archivo.
  const OTRO = '44444444-5555-6666-7777-888888888888';
  await central.applyPlatformPublish(USER_ID, {
    contentId: OTRO, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
  });
  const antes = await espejoDe(PLATFORM_ID);
  assert.deepEqual([antes?.link_state, antes?.content_id], ['linked', OTRO], 'precondición: el espejo lo tiene en el otro archivo');

  // Recién ahora pasa el worker por la operación vieja de A.
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  await repararTransicionesPendientes();

  const despues = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [despues?.link_state, despues?.content_id], ['linked', OTRO],
    'La reparación de A le puso la lápida a un vínculo que ya es del otro archivo. Su alcance viejo ' +
    'lo incluía, pero la fila ya no es de A: repararlo no es trabajo de esta operación.',
  );
});

test('P0 — cada cambio de estado del vínculo sube su revisión', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const versiones: [string, number][] = [];
  const anotar = async () => {
    const f = await espejoDe(PLATFORM_ID);
    versiones.push([f?.link_state ?? 'linked', f?.link_version ?? 0]);
  };
  await anotar();
  for (const [i, accion] of (['unlink', 'publish', 'unlink'] as const).entries()) {
    if (accion === 'publish') {
      await central.applyPlatformPublish(USER_ID, {
        contentId, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
        fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-09T10:00:00.000Z'),
      });
    } else {
      const r = await postTransicion({
        contentId, platform: PLATFORM, action: 'unlink', operationId: `p0-lv-contrato-${i}`,
        baseVersion: await revisionDe(contentId),
      });
      assert.equal(r.status, 200, 'precondición: la transición se aplicó');
    }
    await anotar();
  }

  assert.deepEqual(versiones.map(v => v[0]), ['linked', 'unlinked', 'linked', 'unlinked'], 'precondición');
  for (let i = 1; i < versiones.length; i++) {
    assert.ok(
      versiones[i][1] > versiones[i - 1][1],
      `El paso ${i} (${versiones[i][0]}) no subió la revisión del vínculo: ${JSON.stringify(versiones)}. ` +
      'Es lo que ordenan los dispositivos: dos estados distintos con el mismo número solo se resuelven ' +
      'por una regla de desempate, y cada cliente puede tener la suya.',
    );
  }
});

test('P0 — los push periódicos de una PC no traban un unlink posterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Una fila del espejo de ANTES de la revisión propia del vínculo: sin sello de
  // archivo. Así quedan todas las que ya existen en producción.
  const { contentId } = await sembrarConfirmado();
  const refresco = async (minutos: number) => {
    const { res, captured } = fakeRes();
    await central.bulkUpsertBackupPlatformVideos(
      {
        user: USER, headers: { authorization: AUTH }, params: {}, query: {},
        body: { videos: [{
          platform: PLATFORM, platform_id: PLATFORM_ID, platform_url: PLATFORM_URL,
          content_id: contentId, file_name: 'video integral.mp4', match_status: 'manual',
          local_updated_at: new Date(Date.parse('2026-09-09T10:00:00.000Z') + minutos * 60_000).toISOString(),
        }] },
      } as any,
      res as any,
    );
    assert.equal(captured.body?.updated, 1, 'precondición: el push se aplicó');
  };
  // La PC sigue con el vínculo, y lo empuja en cada tick.
  await refresco(5);
  await refresco(10);

  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-tras-refrescos',
    baseVersion: await revisionDe(contentId),
  });
  assert.equal(r.status, 200, 'precondición: el unlink se aplicó');

  assert.equal(
    (await espejoDe(PLATFORM_ID))?.link_state, 'unlinked',
    'Los refrescos de la PC subieron la revisión del vínculo, y en una fila sin sello de archivo esa ' +
    'revisión es la que se compara contra la del archivo: el unlink la vio "más nueva" y no dejó lápida.',
  );
});

test('P0 — un vínculo que vuelve a su archivo después de reasignarse no queda bloqueado', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId: A } = await sembrarConfirmado();

  // B tiene su propia historia: varias decisiones del usuario sobre ese archivo.
  const B = '55555555-6666-7777-8888-999999999999';
  await central.applyPlatformPublish(USER_ID, {
    contentId: B, platform: PLATFORM, platformId: '17777777777777777',
    platformUrl: 'https://www.instagram.com/reel/CCCCCCCCCCC/', fileName: 'otro video.mp4',
    matchStatus: 'manual', publishedAt: new Date('2026-09-08T10:00:00.000Z'),
  });
  for (const [i, action] of ['discard', 'unlink', 'discard', 'unlink'].entries()) {
    const r = await postTransicion({
      contentId: B, platform: PLATFORM, action, operationId: `p0-lv-ida-b-${i}`,
      baseVersion: await revisionDe(B),
    });
    assert.equal(r.status, 200, 'precondición: la historia de B se aplicó');
  }

  // La publicación se suelta de A, se vincula a B por error...
  const r = await postTransicion({
    contentId: A, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-ida-a',
    baseVersion: await revisionDe(A),
  });
  assert.equal(r.status, 200, 'precondición: el unlink de A se aplicó');
  await central.applyPlatformPublish(USER_ID, {
    contentId: B, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-09T10:00:00.000Z'),
  });
  assert.ok((await revisionDe(B)) > (await revisionDe(A)), 'precondición: B tiene una revisión MAYOR que A');

  // ...y el usuario lo corrige: vuelve a A.
  await central.applyPlatformPublish(USER_ID, {
    contentId: A, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-09T10:00:00.000Z'),
  });

  const archivoA = await central.FileModel.findOne({ userId: USER_ID, content_id: A }).lean();
  const pv = await central.PlatformVideoModel
    .findOne({ userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID }).lean();
  assert.equal(
    String(pv?.linkedFileId), String(archivoA?._id),
    'La vuelta a A quedó bloqueada: el sello de platformvideos seguía diciendo que era de A -- lo dejó ' +
    'la transición de A -- con el número que puso el publish sobre B. Comparado contra la revisión de ' +
    'A, parecía más nuevo. Cada escritura del sello tiene que decir de qué archivo es.',
  );
  const espejo = await espejoDe(PLATFORM_ID);
  assert.deepEqual([espejo?.link_state, espejo?.content_id], ['linked', A], 'y el espejo también vuelve a A');
});

test('P0 — reparar un archivo no pisa un unlink que entra mientras repara', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-carrera';
  // Canónico: "publicado", con el vínculo. La operación vieja queda pendiente.
  await transicionSuperadaAMitad(contentId, op);
  // Adaptado: la reparación solo escribe lo que difiere del estado canónico, y
  // sin algo que escribir no habría escritura en la que intercalar el unlink.
  // La fila falta -- la versión anterior del servicio la borraba --, así que la
  // reparación la va a recrear.
  await central.BackupPlatformVideoModel.deleteOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID });

  // La reparación ya leyó el estado canónico; justo antes de escribir el espejo,
  // el usuario suelta el vínculo.
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'updateOne', async () => {
    const r = await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-reparar-carrera-2',
      baseVersion: await revisionDe(contentId),
    });
    assert.equal(r.status, 200, 'precondición: el unlink del usuario se aplicó');
  });
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  try {
    await vencerLease(op);
    await repararTransicionesPendientes();
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el unlink se intercaló de verdad');

  assert.equal(
    (await espejoDe(PLATFORM_ID))?.link_state, 'unlinked',
    'La reparación volvió a poner `linked` sobre la lápida de un unlink posterior: escribió el estado ' +
    'canónico que había leído, que ya no lo era. El sello de archivo de la fila es el único que sabe ' +
    'que entró algo más nuevo.',
  );
});

// ---------------------------------------------------------------------------
// P0 (revisión) — exactamente una vez, el push de PC y la reparación positiva.
// ---------------------------------------------------------------------------

/** El push periódico de una PC, con la foto que tiene del vínculo. */
async function pushDePC(fila: { platform_id: string; content_id: string; local_updated_at: string; platform_url?: string | null }) {
  const { res, captured } = fakeRes();
  await central.bulkUpsertBackupPlatformVideos(
    {
      user: USER, headers: { authorization: AUTH }, params: {}, query: {},
      body: { videos: [{
        platform: PLATFORM, platform_url: PLATFORM_URL, file_name: 'video integral.mp4',
        match_status: 'manual', ...fila,
      }] },
    } as any,
    res as any,
  );
  return captured.body;
}

test('P0 — una transición sube la revisión del vínculo exactamente una vez, aunque se reanude', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);
  const N = (await espejoDe(PLATFORM_ID))?.link_version ?? 0;
  const op = 'p0-lv-una-vez';

  // El primer intento escribe el espejo y se cae en la proyección siguiente.
  const { applyPlatformTransition } = await import('../services/platform-transition.service');
  const original = central.RemoteLibraryVideoModel.updateOne.bind(central.RemoteLibraryVideoModel);
  let rota = false;
  (central.RemoteLibraryVideoModel as any).updateOne = (...args: any[]) => {
    if (!rota) { rota = true; throw new Error('caída simulada después del espejo'); }
    return original(...args);
  };
  try {
    await applyPlatformTransition(USER_ID, {
      contentId, platform: PLATFORM as any, action: 'unlink', operationId: op, baseVersion: rev0,
    });
    assert.fail('la caída simulada tenía que interrumpir la operación');
  } catch (err: any) {
    if (!/caída simulada/.test(err.message)) throw err;
  } finally {
    (central.RemoteLibraryVideoModel as any).updateOne = original;
  }
  const trasCaida = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [trasCaida?.link_state, trasCaida?.link_version], ['unlinked', N + 1],
    'Una transición es UN cambio de estado del vínculo: N -> N+1. El updateMany y el upsert por id ' +
    'alcanzan la misma fila, y cada uno no puede subirla por su cuenta.',
  );

  // Pasa el tiempo del lease, y la MISMA operación se reanuda y termina.
  await vencerLease(op);
  const r = await postTransicion({ contentId, platform: PLATFORM, action: 'unlink', operationId: op, baseVersion: rev0 });
  assert.equal(r.status, 200, 'precondición: la reanudación terminó');
  assert.equal(
    (await espejoDe(PLATFORM_ID))?.link_version, N + 1,
    'La reanudación volvió a subir la revisión del vínculo: repetir la escritura de la MISMA operación ' +
    'la hace parecer un cambio nuevo, y un dispositivo no puede distinguirlo de uno real.',
  );

  // Y una entrega más, con la operación ya completada, tampoco la mueve.
  await postTransicion({ contentId, platform: PLATFORM, action: 'unlink', operationId: op, baseVersion: rev0 });
  assert.equal((await espejoDe(PLATFORM_ID))?.link_version, N + 1, 'ni la entrega duplicada');
});

test('P0 — el push viejo de una PC no mueve un vínculo vivo a otro archivo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId: A } = await sembrarConfirmado();
  // El vínculo se suelta de A y se publica en B: decisiones causales.
  const r = await postTransicion({
    contentId: A, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-push-viejo',
    baseVersion: await revisionDe(A),
  });
  assert.equal(r.status, 200, 'precondición: el unlink se aplicó');
  const B = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  await central.applyPlatformPublish(USER_ID, {
    contentId: B, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
  });
  const antes = await espejoDe(PLATFORM_ID);
  assert.deepEqual([antes?.link_state, antes?.content_id], ['linked', B], 'precondición: el vínculo es de B');

  // Una PC que todavía no hizo pull lo tiene en A, y empuja su foto con la hora
  // en que lo vinculó.
  await pushDePC({ platform_id: PLATFORM_ID, content_id: A, local_updated_at: '2026-09-01T10:00:00.000Z' });

  const despues = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [despues?.link_state, despues?.content_id, despues?.link_version],
    ['linked', B, antes?.link_version],
    'El push de una foto vieja reasignó un vínculo VIVO a otro archivo, sin ningún contrato causal: ' +
    'la PC no decidió nada, solo no se había enterado. Reasignar es trabajo de un publish o una ' +
    'transición, que sí traen revisión.',
  );
});

/** Contrapeso: revivir una lápida para otro archivo sí es una reasignación real. */
test('P0 — una PC que revive una lápida para otro archivo lo reasigna y sube la revisión', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId: A } = await sembrarConfirmado();
  const r = await postTransicion({
    contentId: A, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-push-revive-otro',
    baseVersion: await revisionDe(A),
  });
  assert.equal(r.status, 200, 'precondición: el unlink se aplicó');
  const lapida = await espejoDe(PLATFORM_ID);

  const B = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
  const despues = new Date(new Date(lapida.link_updated_at).getTime() + 60_000).toISOString();
  await pushDePC({ platform_id: PLATFORM_ID, content_id: B, local_updated_at: despues });

  const fila = await espejoDe(PLATFORM_ID);
  assert.deepEqual([fila?.link_state, fila?.content_id], ['linked', B]);
  assert.ok((fila?.link_version ?? 0) > (lapida?.link_version ?? 0), 'y sube la revisión');
});

/** Contrapeso: completar el contenido de una fila vieja no es mover el vínculo. */
test('P0 — una PC completa el contenido de una fila vieja que no lo tenía', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // Filas del espejo de antes de `content_id`: las hay en producción.
  await central.BackupPlatformVideoModel.updateOne(
    { userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID },
    { $unset: { content_id: '' } },
  );
  await pushDePC({ platform_id: PLATFORM_ID, content_id: contentId, local_updated_at: '2026-09-09T10:00:00.000Z' });

  const fila = await espejoDe(PLATFORM_ID);
  assert.deepEqual([fila?.link_state, fila?.content_id], ['linked', contentId]);
});

/** Contrapeso: repetir un push idéntico no es un cambio. */
test('P0 — repetir el mismo push de PC no sube la revisión del vínculo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const NUEVO = '17666666666666661';
  const fila = { platform_id: NUEVO, content_id: contentId, local_updated_at: '2026-09-09T10:00:00.000Z' };
  await pushDePC(fila);
  const creada = await espejoDe(NUEVO);
  assert.ok((creada?.link_version ?? 0) > 0, 'precondición: crearla sí subió la revisión');

  await pushDePC(fila);
  await pushDePC(fila);
  assert.equal((await espejoDe(NUEVO))?.link_version, creada?.link_version, 'la misma foto no es un cambio');
});

test('P0 — reparar un archivo publicado recrea el espejo que falta', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-ausente';
  // Una operación superada a mitad: el estado canónico es "publicado", con el vínculo.
  await transicionSuperadaAMitad(contentId, op);

  // Y la fila del espejo de ese vínculo no está. La versión anterior del
  // servicio de transiciones la borraba con deleteMany: las hay así.
  await central.BackupPlatformVideoModel.deleteOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID });

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  await repararTransicionesPendientes();
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  const fila = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [fila?.link_state, fila?.content_id, fila?.platform_url], ['linked', contentId, PLATFORM_URL],
    'La reparación dio por cerrada la operación sin recrear la proyección que falta: el updateOne ' +
    'del vínculo vivo no tenía upsert. Las PCs reconstruyen sus links desde este espejo -- con la ' +
    'URL --, así que para ellas el vínculo sigue sin existir.',
  );
});

// ---------------------------------------------------------------------------
// P0 (revisión) — carreras del push de PC y de la reparación.
//
// Leer el vínculo y escribirlo después deja una ventana: lo que entre en el
// medio queda pisado por una decisión tomada sobre la foto de antes. La
// escritura tiene que ser un CAS contra el `link_version` que se leyó -- y
// para una fila que no existía, un insert que ante E11000 entiende que otro
// ganó.
// ---------------------------------------------------------------------------

/** Deja que el tiempo del backoff pase, como `vencerLease` con el del lease. */
async function vencerEspera(operationId: string) {
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');
  await PlatformTransitionOpModel.updateOne(
    { userId: USER_ID, operationId },
    { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
  );
}

test('P0 — el push de una PC no pisa una transición que entra mientras lo aplica', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // La PC empuja su foto: el vínculo vivo. Entre que el push lee el espejo y lo
  // escribe, el usuario suelta el vínculo desde el teléfono.
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'bulkWrite', async () => {
    const r = await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-push-toctou',
      baseVersion: await revisionDe(contentId),
    });
    assert.equal(r.status, 200, 'precondición: el unlink se aplicó');
  });
  try {
    await pushDePC({ platform_id: PLATFORM_ID, content_id: contentId, local_updated_at: '2026-09-01T10:00:00.000Z' });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el unlink se intercaló de verdad');

  assert.equal(
    (await espejoDe(PLATFORM_ID))?.link_state, 'unlinked',
    'El push escribió su foto -- leída ANTES del unlink -- sobre la lápida, y revivió el vínculo. La ' +
    'escritura tiene que ser un CAS contra el `link_version` que el push leyó.',
  );
});

test('P0 — el push de una PC no pisa una fila que otro crea mientras lo aplica', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const NUEVO = '17666666666666662';
  const URL_PUBLICADA = 'https://www.instagram.com/reel/PUBLICADO/';
  // El push ve que la fila no existe. Antes de escribir, un publish la crea.
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'bulkWrite', async () => {
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: NUEVO, platformUrl: URL_PUBLICADA,
      fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
    });
  });
  let cuerpo: any;
  try {
    cuerpo = await pushDePC({ platform_id: NUEVO, content_id: contentId, local_updated_at: '2026-09-01T10:00:00.000Z' });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el publish se intercaló de verdad');

  assert.equal(
    (await espejoDe(NUEVO))?.platform_url, URL_PUBLICADA,
    'El push pisó la fila que el publish creó mientras tanto: la creía ausente, e hizo upsert sobre ' +
    'ella. Para una fila ausente la escritura es un insert, y un E11000 quiere decir que otro ganó.',
  );
  assert.equal(cuerpo?.ok, true, 'y el push termina bien: perder esa fila no es un error de la PC');
});

/**
 * Una reparación de A con algo que escribir en el espejo, y la MISMA
 * publicación reasignándose a B -- con una revisión de archivo menor -- justo
 * antes de esa escritura.
 */
async function repararConReasignacionIntercalada(op: string, prepararEspejo: () => Promise<void>) {
  const { contentId } = await sembrarConfirmado();
  // Canónico: "publicado", con el vínculo en A. La operación vieja queda pendiente.
  await transicionSuperadaAMitad(contentId, op);
  await prepararEspejo();

  const B = '88888888-9999-aaaa-bbbb-cccccccccccc';
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'updateOne', async () => {
    await central.applyPlatformPublish(USER_ID, {
      contentId: B, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
      fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
    });
  });
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  try {
    await vencerLease(op);
    await repararTransicionesPendientes();
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la reasignación se intercaló de verdad');
  assert.ok((await revisionDe(B)) < (await revisionDe(contentId)), 'precondición: B tiene una revisión MENOR que A');
  return { contentId, B };
}

test('P0 — reparar un archivo no pisa una reasignación que entra mientras repara (lápida vieja)', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // La fila del espejo tiene una lápida vieja sobre un vínculo vivo: la dejaba
  // el upsert del tombstone sin guard que corrigió P1-3, y la reparación existe
  // justamente para levantarla.
  const { B } = await repararConReasignacionIntercalada('p0-lv-reparar-reasignado', async () => {
    await central.BackupPlatformVideoModel.updateOne(
      { userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID },
      { $set: { link_state: 'unlinked' } },
    );
  });

  const fila = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [fila?.link_state, fila?.content_id], ['linked', B],
    'La reparación de A trajo de vuelta un vínculo que ya es de B. Su guard comparaba la revisión de ' +
    'archivo de la fila -- la de B -- contra la de A: dominios distintos. Tiene que ser un CAS contra ' +
    'el `link_version` que la reparación leyó.',
  );
});

test('P0 — reparar un archivo no pisa una reasignación que entra mientras repara (fila ausente)', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // La fila del espejo no está: la versión anterior del servicio la borraba.
  // La reparación la va a recrear -- y en el medio la crea el publish sobre B.
  const { B } = await repararConReasignacionIntercalada('p0-lv-reparar-ausente-reasignado', async () => {
    await central.BackupPlatformVideoModel.deleteOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID });
  });

  const fila = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [fila?.link_state, fila?.content_id], ['linked', B],
    'La reparación recreó la fila sobre la que el publish de B acababa de crear. Para una fila ausente ' +
    'la escritura es un insert, y un E11000 quiere decir que otro ganó.',
  );
});

test('P0 — repetir una reparación que se cayó antes de cerrar no vuelve a subir la revisión', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-caida';
  await transicionSuperadaAMitad(contentId, op);
  // La fila del espejo no está (la versión anterior del servicio la borraba):
  // la reproyección tiene algo que hacer.
  await central.BackupPlatformVideoModel.deleteOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID });

  // La reparación reproyecta y se cae ANTES de cerrar la operación.
  const { PlatformTransitionOpModel } = await import('../models/platform-transition-op.model');
  const original = PlatformTransitionOpModel.updateOne.bind(PlatformTransitionOpModel);
  let rota = false;
  (PlatformTransitionOpModel as any).updateOne = (filtro: any, cambio: any, ...resto: any[]) => {
    if (!rota && cambio?.$set?.status) { rota = true; throw new Error('caída simulada antes de cerrar'); }
    return original(filtro, cambio, ...resto);
  };
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  try {
    await vencerLease(op);
    await repararTransicionesPendientes();
  } finally {
    (PlatformTransitionOpModel as any).updateOne = original;
  }
  assert.ok(rota, 'precondición: la caída ocurrió');
  assert.equal((await registroDe(op))?.status, 'pending', 'precondición: la operación quedó sin cerrar');
  const trasPrimera = await espejoDe(PLATFORM_ID);
  assert.equal(trasPrimera?.link_state, 'linked', 'precondición: la reproyección recreó la fila');

  // Pasa el backoff, y el worker vuelve a tomar la MISMA reparación.
  await vencerEspera(op);
  await repararTransicionesPendientes();
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: esta vez se cerró');

  assert.equal(
    (await espejoDe(PLATFORM_ID))?.link_version, trasPrimera?.link_version,
    'Repetir la reproyección volvió a subir la revisión del vínculo, sin ningún cambio: el primer ' +
    'intento ya había dejado la fila en el estado canónico. Un dispositivo no puede distinguir ese ' +
    'número de un cambio real.',
  );
});

test('P0 — reparar un archivo cuyo espejo ya refleja el estado canónico no sube la revisión', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-sin-cambio';
  await transicionSuperadaAMitad(contentId, op);
  // El usuario suelta el vínculo: el canónico pasa a "desvinculado", y la
  // transición ya dejó la lápida.
  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-reparar-sin-cambio-2',
    baseVersion: await revisionDe(contentId),
  });
  assert.equal(r.status, 200, 'precondición: el unlink se aplicó');
  const antes = await espejoDe(PLATFORM_ID);
  assert.equal(antes?.link_state, 'unlinked', 'precondición: la lápida ya está');

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  await repararTransicionesPendientes();
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  assert.equal(
    (await espejoDe(PLATFORM_ID))?.link_version, antes?.link_version,
    'La reparación volvió a poner la lápida que ya estaba y le subió la revisión: un cambio que no ' +
    'ocurrió. Reproyectar tiene que escribir solo lo que difiere del estado canónico.',
  );
});

// ---------------------------------------------------------------------------
// P0 (revisión) — las dos revisiones del vínculo avanzan por motivos distintos.
//
//   cambio del vínculo                     → avanzan `link_file_rev` y `link_version`
//   mismo vínculo, nueva revisión causal   → avanza solo `link_file_rev`
//   reintento idéntico                     → no avanza ninguna
// ---------------------------------------------------------------------------

/**
 * Como `conIntercaladoEn`, pero para una LECTURA encadenada
 * (`find(...).select(...).lean()`): corre `intercalar` justo antes de que se
 * ejecute la primera consulta cuyo filtro cumpla `esEsta`. El método envuelto
 * tiene que seguir devolviendo la Query -- una promesa rompe el encadenado.
 */
function conIntercaladoAntesDeLeer(
  modelo: any, metodo: string, esEsta: (filtro: any) => boolean, intercalar: () => Promise<void>,
) {
  const original = modelo[metodo];
  let tomada = false;
  let hecho = false;
  modelo[metodo] = function (...args: any[]) {
    const q = original.apply(modelo, args);
    if (!tomada && esEsta(args[0])) {
      tomada = true;
      modelo[metodo] = original;   // el intercalado usa el método de verdad
      const ejecutar = q.exec.bind(q);
      q.exec = async (...a: any[]) => { await intercalar(); hecho = true; return ejecutar(...a); };
    }
    return q;
  };
  return {
    restore: () => { modelo[metodo] = original; },
    get hecho() { return hecho; },
  };
}

test('P0 — reparar un archivo no pisa una reasignación que entra antes de leer el espejo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-entre-lecturas';
  // Canónico: "publicado", con el vínculo en A. La operación vieja queda pendiente.
  await transicionSuperadaAMitad(contentId, op);

  // La reparación ya leyó en platformvideos que el vínculo es de A. Antes de que
  // lea el espejo, la MISMA publicación se reasigna a B. Cuando lo lee ya ve la
  // fila de B, con el `link_version` que dejó esa reasignación: un CAS contra lo
  // leído matchea. Lo único que sabe que el vínculo ya no es de A es volver a
  // mirar platformvideos DESPUÉS de leer el espejo.
  const B = '99999999-aaaa-bbbb-cccc-dddddddddddd';
  const espia = conIntercaladoAntesDeLeer(
    central.BackupPlatformVideoModel, 'find', (f: any) => !!f?.platform_id?.$in,
    async () => {
      await central.applyPlatformPublish(USER_ID, {
        contentId: B, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
        fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
      });
    },
  );
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  try {
    await vencerLease(op);
    await repararTransicionesPendientes();
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la reasignación se intercaló antes de leer el espejo');
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  const fila = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [fila?.link_state, fila?.content_id], ['linked', B],
    'La reparación de A trajo de vuelta un vínculo que ya es de B. La reasignación entró entre la ' +
    'primera lectura de platformvideos y la del espejo: el CAS se hizo contra un `link_version` que ' +
    'ya era el de B, y matcheó.',
  );
});

test('P0 — dos PCs que completan a la vez el contenido de una fila vieja: gana una, y la revisión sube una vez', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId: A } = await sembrarConfirmado();
  // Una fila del espejo de antes de `content_id`: las hay en producción.
  await central.BackupPlatformVideoModel.updateOne(
    { userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID },
    { $unset: { content_id: '' } },
  );
  const N = (await espejoDe(PLATFORM_ID))?.link_version ?? 0;

  // Dos PCs la completan, cada una con el contenido que tiene. La segunda entra
  // entre que la primera lee el espejo y lo escribe.
  const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let segunda: any;
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'bulkWrite', async () => {
    segunda = await pushDePC({ platform_id: PLATFORM_ID, content_id: B, local_updated_at: '2026-09-09T10:05:00.000Z' });
  });
  let primera: any;
  try {
    primera = await pushDePC({ platform_id: PLATFORM_ID, content_id: A, local_updated_at: '2026-09-09T10:00:00.000Z' });
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la segunda PC se intercaló de verdad');
  assert.equal(segunda?.updated, 1, 'precondición: la PC que escribió primero completó la fila');

  const fila = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [fila?.content_id, fila?.link_version], [B, N + 1],
    'Las dos PCs superaron el CAS: completar el contenido no subía la revisión del vínculo, así que la ' +
    'segunda escritura encontró el mismo número que había leído y pisó a la primera. Completar ES un ' +
    'cambio del vínculo: sube su revisión, y con eso el CAS de la otra deja de matchear.',
  );
  assert.equal(primera?.updated, 0, 'y la PC que perdió no cuenta su foto como aplicada');
});

test('P0 — reparar un vínculo que ya está vivo adelanta su revisión de archivo y completa la URL, sin anunciar un cambio', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-vivo';
  // Canónico: "publicado", con el vínculo en A. La operación vieja queda pendiente.
  await transicionSuperadaAMitad(contentId, op);
  const rev = await revisionDe(contentId);

  // La fila del espejo no está (la versión anterior del servicio la borraba) y
  // una PC la vuelve a crear con su push: viva y del mismo contenido, pero con
  // la revisión de archivo en 0 -- la PC no la trae -- y sin URL, que esa PC no
  // tenía.
  await central.BackupPlatformVideoModel.deleteOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID });
  await pushDePC({ platform_id: PLATFORM_ID, content_id: contentId, platform_url: null, local_updated_at: '2026-09-09T15:00:00.000Z' });
  const antes = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [antes?.link_state, antes?.content_id, antes?.link_file_rev, antes?.platform_url ?? null],
    ['linked', contentId, 0, null],
    'precondición: vivo en A, sin revisión de archivo y sin URL',
  );
  assert.ok(rev > 0, 'precondición: el estado vigente tiene revisión');

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  await repararTransicionesPendientes();
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  const despues = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [despues?.link_file_rev, despues?.platform_url], [rev, PLATFORM_URL],
    'La reparación vio el vínculo vivo en su contenido y no escribió nada. La fila refleja el estado ' +
    `de la revisión ${rev} pero sigue sellada con 0: una escritura atrasada de este mismo archivo -- ` +
    'con una revisión menor -- todavía la supera. Y sigue sin la URL que tiene platformvideos, con ' +
    'la que las PCs reconstruyen el link.',
  );
  assert.equal(
    despues?.link_version, antes?.link_version,
    'y sin subir la revisión del vínculo: es el mismo vínculo, vivo y en el mismo archivo. Un ' +
    'dispositivo no puede distinguir ese número de un cambio real.',
  );
});

/** Contrapeso: completar es completar, no reemplazar lo que el espejo ya tiene. */
test('P0 — reparar un vínculo que ya está vivo no pisa la URL que tiene el espejo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-vivo-url';
  await transicionSuperadaAMitad(contentId, op);
  // Una PC empuja el mismo vínculo con la URL en otra forma.
  const URL_DE_LA_PC = 'https://www.instagram.com/p/AAAAAAAAAAA/';
  await pushDePC({ platform_id: PLATFORM_ID, content_id: contentId, platform_url: URL_DE_LA_PC, local_updated_at: '2026-09-09T15:00:00.000Z' });
  assert.equal((await espejoDe(PLATFORM_ID))?.platform_url, URL_DE_LA_PC, 'precondición');

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  await repararTransicionesPendientes();
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  assert.equal((await espejoDe(PLATFORM_ID))?.platform_url, URL_DE_LA_PC);
});

test('P0 — reparar un vínculo que ya está suelto adelanta su revisión de archivo, sin anunciar un cambio', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-suelto';
  await transicionSuperadaAMitad(contentId, op);
  // El usuario suelta el vínculo -- la transición deja la lápida -- y después
  // descarta la plataforma. El descarte ya no alcanza la lápida: no queda ningún
  // vínculo vivo en su alcance.
  for (const [i, action] of ['unlink', 'discard'].entries()) {
    const r = await postTransicion({
      contentId, platform: PLATFORM, action, operationId: `p0-lv-reparar-suelto-${i}`,
      baseVersion: await revisionDe(contentId),
    });
    assert.equal(r.status, 200, `precondición: ${action} se aplicó`);
  }
  const rev = await revisionDe(contentId);
  const antes = await espejoDe(PLATFORM_ID);
  assert.equal(antes?.link_state, 'unlinked', 'precondición: la lápida está');
  assert.ok(
    typeof antes?.link_file_rev === 'number' && antes.link_file_rev < rev,
    `precondición: la lápida quedó sellada con la revisión del unlink (${antes?.link_file_rev}), anterior a la vigente (${rev})`,
  );

  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  await repararTransicionesPendientes();
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  const despues = await espejoDe(PLATFORM_ID);
  assert.equal(
    despues?.link_file_rev, rev,
    'La reparación reproyectó el estado vigente y dejó la lápida sellada con la revisión del unlink: ' +
    'como ya estaba suelta, no escribió nada. Una escritura atrasada de este mismo archivo, con una ' +
    'revisión entre esas dos, todavía la supera.',
  );
  assert.deepEqual(
    [despues?.link_state, despues?.link_version], ['unlinked', antes?.link_version],
    'y sin subir la revisión del vínculo: sigue suelto, como estaba',
  );
});

// Sellar una fila es escribirla, y las mismas carreras valen: no puede sellar
// una fila que en el medio pasó a otro contenido, ni hacer retroceder la
// revisión de archivo de una que en el medio escribió algo más nuevo.

/** A acumula revisiones con decisiones reales: soltar y volver a publicar. */
async function historiaEn(contentId: string, vueltas: number, prefijo: string) {
  for (let i = 0; i < vueltas; i++) {
    const r = await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink', operationId: `${prefijo}-${i}`,
      baseVersion: await revisionDe(contentId),
    });
    assert.equal(r.status, 200, 'precondición: la historia se aplicó');
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
      fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-09T10:00:00.000Z'),
    });
  }
}

test('P0 — reparar un vínculo vivo no sella con su revisión una reasignación que entra mientras repara', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId: A } = await sembrarConfirmado();
  await historiaEn(A, 2, 'p0-lv-sello-reasignado-historia');
  const op = 'p0-lv-sello-reasignado';
  // Canónico: "publicado", y el espejo ya lo refleja: a la reparación solo le
  // queda sellar la fila. Justo antes de esa escritura, la publicación se
  // reasigna a B.
  await transicionSuperadaAMitad(A, op);
  const B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'updateOne', async () => {
    await central.applyPlatformPublish(USER_ID, {
      contentId: B, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
      fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
    });
  });
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  try {
    await vencerLease(op);
    await repararTransicionesPendientes();
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la reasignación se intercaló de verdad');
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  // Después, el usuario suelta el vínculo de B.
  const revB = await revisionDe(B);
  assert.ok(revB + 1 < (await revisionDe(A)), 'precondición: el unlink de B lleva una revisión menor que la de A');
  const r = await postTransicion({
    contentId: B, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-sello-reasignado-b', baseVersion: revB,
  });
  assert.equal(r.status, 200, 'precondición: el unlink de B se aplicó');

  assert.equal(
    (await espejoDe(PLATFORM_ID))?.link_state, 'unlinked',
    'El unlink de B no dejó la lápida. La reparación de A selló la fila -- que ya era de B -- con la ' +
    'revisión de A, y el guard del unlink, que compara revisiones de B, la vio más nueva. Sellar solo ' +
    'vale sobre una fila del mismo contenido.',
  );
});

test('P0 — reparar un vínculo vivo no hace retroceder la revisión de un unlink que entra mientras repara', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-sello-vivo-atrasado';
  // Canónico: "publicado", y el espejo ya lo refleja: a la reparación solo le
  // queda sellar la fila. Justo antes de esa escritura, el usuario lo suelta.
  await transicionSuperadaAMitad(contentId, op);
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'updateOne', async () => {
    const r = await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-sello-vivo-atrasado-2',
      baseVersion: await revisionDe(contentId),
    });
    assert.equal(r.status, 200, 'precondición: el unlink del usuario se aplicó');
  });
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  try {
    await vencerLease(op);
    await repararTransicionesPendientes();
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el unlink se intercaló de verdad');

  const fila = await espejoDe(PLATFORM_ID);
  assert.equal(fila?.link_state, 'unlinked', 'precondición: la lápida del unlink sigue puesta');
  assert.equal(
    fila?.link_file_rev, await revisionDe(contentId),
    'La reparación selló la lápida con la revisión del estado que había leído, anterior a la del ' +
    'unlink: la revisión de archivo de la fila retrocedió, y una escritura de este archivo con una ' +
    'revisión entre esas dos ya la supera.',
  );
});

test('P0 — reparar un vínculo suelto no sella con su revisión uno que ya es de otro', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId: A } = await sembrarConfirmado();
  const op = 'p0-lv-sello-suelto-otro';
  // Queda una operación de A pendiente y superada, con este vínculo en su alcance.
  await transicionSuperadaAMitad(A, op);
  // El usuario suelta el vínculo de A, y lo publica sobre B.
  const r = await postTransicion({
    contentId: A, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-sello-suelto-otro-2',
    baseVersion: await revisionDe(A),
  });
  assert.equal(r.status, 200, 'precondición: el unlink de A se aplicó');
  const B = 'cccccccc-dddd-eeee-ffff-000000000000';
  await central.applyPlatformPublish(USER_ID, {
    contentId: B, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
  });

  // Recién ahora pasa el worker por la operación vieja de A: canónico "desvinculado".
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  await repararTransicionesPendientes();
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  // Después, el usuario suelta el vínculo de B.
  const revB = await revisionDe(B);
  assert.ok(revB + 1 < (await revisionDe(A)), 'precondición: el unlink de B lleva una revisión menor que la de A');
  const r2 = await postTransicion({
    contentId: B, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-sello-suelto-otro-b', baseVersion: revB,
  });
  assert.equal(r2.status, 200, 'precondición: el unlink de B se aplicó');

  assert.equal(
    (await espejoDe(PLATFORM_ID))?.link_state, 'unlinked',
    'El unlink de B no dejó la lápida. La reparación de A selló la fila -- que ya era de B -- con la ' +
    'revisión de A, y el guard del unlink, que compara revisiones de B, la vio más nueva. Su alcance ' +
    'viejo la incluía, pero sellarla no es trabajo de esta operación.',
  );
});

test('P0 — reparar un vínculo suelto no hace retroceder la revisión de lo que entra mientras repara', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-sello-suelto-atrasado';
  await transicionSuperadaAMitad(contentId, op);
  // El usuario suelta el vínculo: el canónico pasa a "desvinculado".
  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-sello-suelto-atrasado-2',
    baseVersion: await revisionDe(contentId),
  });
  assert.equal(r.status, 200, 'precondición: el unlink se aplicó');

  // La reparación ya leyó ese estado. Justo antes de sellar la lápida, el
  // usuario vuelve a publicar el vínculo en A y lo vuelve a soltar.
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'updateOne', async () => {
    await central.applyPlatformPublish(USER_ID, {
      contentId, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
      fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-09T10:00:00.000Z'),
    });
    const r2 = await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink', operationId: 'p0-lv-sello-suelto-atrasado-3',
      baseVersion: await revisionDe(contentId),
    });
    assert.equal(r2.status, 200, 'precondición: el segundo unlink se aplicó');
  });
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  try {
    await vencerLease(op);
    await repararTransicionesPendientes();
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la vuelta se intercaló de verdad');

  const fila = await espejoDe(PLATFORM_ID);
  assert.equal(fila?.link_state, 'unlinked', 'precondición: la lápida del segundo unlink está');
  assert.equal(
    fila?.link_file_rev, await revisionDe(contentId),
    'La reparación selló la lápida con la revisión del estado que había leído, anterior a la del ' +
    'segundo unlink: la revisión de archivo de la fila retrocedió.',
  );
});

test('P0 — repetir el mismo publish no mueve la revisión ni el reloj del vínculo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const publicar = () => central.applyPlatformPublish(USER_ID, {
    contentId, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-01T10:00:00.000Z'),
  });
  // El primero deja el vínculo como lo describe este publish. Los que siguen son
  // reintentos idénticos: recordUploadEvent reintentado, el outbox de
  // local-backend reenviando el mismo evento.
  await publicar();
  const antes = await espejoDe(PLATFORM_ID);
  assert.deepEqual([antes?.link_state, antes?.content_id], ['linked', contentId], 'precondición');
  // Que un reloj movido se note aunque la máquina sea rápida.
  await new Promise(r => setTimeout(r, 20));
  await publicar();
  await publicar();

  const despues = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [despues?.link_version, despues?.link_file_rev, despues?.link_updated_at?.getTime()],
    [antes?.link_version, antes?.link_file_rev, antes?.link_updated_at?.getTime()],
    'Repetir el MISMO publish movió la revisión o el reloj del vínculo: el espejo sube `link_version` ' +
    'y pone `link_updated_at` en ahora sin mirar si algo cambió. Un dispositivo no puede distinguir ' +
    'ese número de un cambio real, y el reloj movido hace que el guard de tombstone del push de PC ' +
    'descarte pushes legítimos.',
  );
});

test('P0 — reparar un vínculo vivo no pisa una URL que otro completa mientras repara', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-url-carrera';
  // Canónico: "publicado", con el vínculo en A. La operación vieja queda pendiente.
  await transicionSuperadaAMitad(contentId, op);
  const rev = await revisionDe(contentId);
  // Una PC recrea la fila del espejo sin URL (la versión anterior del servicio
  // la borraba): viva, del mismo contenido, sellada en 0.
  await central.BackupPlatformVideoModel.deleteOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID });
  await pushDePC({ platform_id: PLATFORM_ID, content_id: contentId, platform_url: null, local_updated_at: '2026-09-09T15:00:00.000Z' });
  assert.equal((await espejoDe(PLATFORM_ID))?.platform_url ?? null, null, 'precondición: el espejo no tiene URL');

  // La reparación ya leyó el espejo sin URL. Justo antes de sellarlo, otra PC
  // lo empuja con la suya.
  const URL_DE_LA_PC = 'https://www.instagram.com/p/AAAAAAAAAAA/';
  const espia = await conIntercaladoEn(central.BackupPlatformVideoModel, 'updateOne', async () => {
    const r = await pushDePC({
      platform_id: PLATFORM_ID, content_id: contentId, platform_url: URL_DE_LA_PC, local_updated_at: '2026-09-09T15:05:00.000Z',
    });
    assert.equal(r?.updated, 1, 'precondición: el push de la otra PC se aplicó');
  });
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  try {
    await vencerLease(op);
    await repararTransicionesPendientes();
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el push se intercaló de verdad');
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  const fila = await espejoDe(PLATFORM_ID);
  assert.equal(
    fila?.platform_url, URL_DE_LA_PC,
    'La reparación decidió completar la URL mirando la foto que había leído -- vacía -- y la escribió ' +
    'encima de la que otra PC completó mientras tanto. Completar tiene que ser una condición de la ' +
    'propia escritura: solo si la URL sigue vacía.',
  );
  assert.equal(fila?.link_file_rev, rev, 'y el sello se aplica igual');
});

// ---------------------------------------------------------------------------
// `mark_published`: "publicado sin enlace" como transición CAUSAL.
//
// Era el último camino que seguía escribiendo estado por fuera del escritor
// único: el toggle pendiente -> publicado de iOS mandaba el snapshot de badges
// entero (a `file-platforms` y al video de Nube), sin revisión. Pasa a ser una
// tercera acción con `operationId`, `baseVersion`, CAS y las mismas
// proyecciones -- pero SIN crear `PlatformVideo`, sin tombstones y sin tocar el
// historial: no hubo una publicación real, solo una marca manual.
// ---------------------------------------------------------------------------

const OTRA = 'youtube';

async function marcarPublicado(contentId: string, op: string, baseVersion?: number) {
  return postTransicion({
    contentId, platform: OTRA, action: 'mark_published', operationId: op,
    baseVersion: baseVersion ?? await revisionDe(contentId, OTRA),
  });
}

test('MARK_PUBLISHED — el endpoint acepta la tercera acción', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const r = await marcarPublicado(contentId, 'op-mp-1');

  assert.equal(
    r.status, 200,
    `Hoy responde ${r.status}: "publicado sin enlace" no tiene transición, y el cliente no tiene otra ` +
    'forma de declararlo que el snapshot de badges -- el último escritor no causal.',
  );
  assert.equal(r.body?.version, 1, 'mueve la revisión de ESA plataforma, como cualquier transición');
});

test('MARK_PUBLISHED — deja badge_only en files, backup_files y Nube', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  await marcarPublicado(contentId, 'op-mp-2');

  const file: any = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok(file.platforms.includes(OTRA), 'files: la plataforma queda publicada');
  assert.deepEqual(
    (file.platform_states ?? []).filter((s: any) => s.platform === OTRA).map((s: any) => s.state), ['badge_only'],
    'Como badge_only, NO confirmed: no hay un link que lo respalde. Marcarlo confirmed haría que ' +
    'Estadísticas y el Calendario lo trataran como una publicación real.',
  );
  const backup: any = await central.BackupFileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok(backup.platforms.includes(OTRA), 'backup_files también');
  const nube: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  assert.ok(nube.platforms.includes(OTRA), 'y Nube, que es lo que hoy solo llega por el snapshot');
  assert.deepEqual(
    (nube.platformStates ?? []).filter((s: any) => s.platform === OTRA).map((s: any) => s.state), ['badge_only'],
  );
  assert.ok(file.platforms.includes(PLATFORM), 'y no toca las OTRAS plataformas');
});

test('MARK_PUBLISHED — desde descartado, saca la plataforma de descartadas', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  await postTransicion({
    contentId, platform: OTRA, action: 'discard', operationId: 'op-mp-d', baseVersion: await revisionDe(contentId, OTRA),
  });
  await marcarPublicado(contentId, 'op-mp-3');

  const file: any = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok(!(file.platforms_discarded ?? []).includes(OTRA), 'deja de estar descartada');
  assert.ok(file.platforms.includes(OTRA));
  const nube: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  assert.ok(!(nube.platformsDiscarded ?? []).includes(OTRA), 'también en Nube');
});

test('MARK_PUBLISHED — no fabrica una publicación real', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  // `central` no carga este modelo: se importa directo, para que el caso falle
  // por lo que declara y no por un `undefined`.
  const { UploadHistoryModel } = await import('../models/upload-history.model');
  const antes = await UploadHistoryModel.countDocuments({ userId: USER_ID });
  const r = await marcarPublicado(contentId, 'op-mp-4');
  assert.equal(r.status, 200, 'precondición: se aplicó');

  assert.equal(
    await central.PlatformVideoModel.countDocuments({ userId: USER_ID, platform: OTRA }), 0,
    'Sin `PlatformVideo`: no hay platformId que vincular. Crear uno vacío lo haría aparecer como ' +
    'candidato en Sincronizar y como publicación en Estadísticas.',
  );
  assert.equal(
    await central.BackupPlatformVideoModel.countDocuments({ userId: USER_ID, platform: OTRA }), 0,
    'ni fila en el espejo de vínculos que leen las PCs',
  );
  assert.equal(
    await UploadHistoryModel.countDocuments({ userId: USER_ID }), antes,
    'ni entrada de historial: el Calendario y el Historial no pueden contar una publicación que no ocurrió',
  );
});

test('MARK_PUBLISHED — una base vieja no pisa un cambio posterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const base = await revisionDe(contentId, OTRA);
  await postTransicion({ contentId, platform: OTRA, action: 'discard', operationId: 'op-mp-otro', baseVersion: base });

  const r = await marcarPublicado(contentId, 'op-mp-5', base);

  assert.equal(r.status, 409, 'decidido sobre una revisión que ya no es la vigente: llega tarde');
  const file: any = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok((file.platforms_discarded ?? []).includes(OTRA), 'y el descarte posterior sigue en pie');
});

// El alcance de `mark_published` es VACÍO por definición, no "los vinculados
// de la base". Solo se nota si hay un vínculo vivo de esa plataforma cuando
// llega -- y lo hay cuando la publicación entró por un camino que no mueve la
// revisión: `PlatformVideoModel` directo, como todavía hacen los callers sin
// migrar (el mismo camino que usa P1-2). El guard de revisión no la protege.
test('MARK_PUBLISHED — no suelta un vínculo que entró por otro camino', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const file: any = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  const ID_YT = 'yt-entro-por-otro-camino';
  await central.PlatformVideoModel.create({
    userId: USER_ID, platform: OTRA, platformId: ID_YT,
    platformUrl: 'https://www.youtube.com/shorts/yt-entro-por-otro-camino',
    linkedFileId: file._id, matchStatus: 'manual',
    publishedAt: new Date('2026-09-08T12:00:00.000Z'),
  });
  const base = await revisionDe(contentId, OTRA);

  const r = await marcarPublicado(contentId, 'op-mp-6', base);
  assert.equal(r.status, 200, 'precondición: la base es la vigente, así que se aplica');

  const pv: any = await central.PlatformVideoModel.findOne({ userId: USER_ID, platformId: ID_YT }).lean();
  assert.ok(
    pv?.linkedFileId,
    'El vínculo real de YouTube fue soltado por una marca manual. "Publicado sin enlace" no tiene ' +
    'ningún link en su alcance: tomar como alcance los vinculados de la base se lleva puesta una ' +
    'publicación que la operación nunca vio.',
  );
  assert.equal(
    await central.BackupPlatformVideoModel.countDocuments({
      userId: USER_ID, platform: OTRA, platform_id: ID_YT, link_state: 'unlinked',
    }), 0,
    'ni le escribe un tombstone, que las PCs y los teléfonos aplicarían como un unlink',
  );
});

test('MARK_PUBLISHED — sobre una plataforma confirmada conserva confirmed y sus vínculos', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Instagram está confirmado, con su link real, en todas las representaciones.
  const { contentId } = await sembrarConfirmado();
  const archivo: any = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  const espejoAntes = await espejoDe(PLATFORM_ID);

  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'mark_published', operationId: 'op-mp-confirmado',
    baseVersion: await revisionDe(contentId),
  });
  assert.equal(r.status, 200, 'precondición: la base es la vigente, así que se aplica');

  const estados = (doc: any, campo: string) =>
    (doc?.[campo] ?? []).filter((s: any) => s.platform === PLATFORM).map((s: any) => s.state);
  const file: any = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.deepEqual(
    [file.platforms.includes(PLATFORM), estados(file, 'platform_states')], [true, ['confirmed']],
    'La marca manual degradó una publicación confirmada a badge_only. `confirmed` es el estado más ' +
    'fuerte: "publicado sin enlace" sobre algo que ya tiene enlace no le quita nada.',
  );
  const backup: any = await central.BackupFileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok(backup.platforms.includes(PLATFORM), 'backup_files: sigue publicada');
  const nube: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  assert.deepEqual(estados(nube, 'platformStates'), ['confirmed'], 'Nube: sigue confirmada');
  assert.deepEqual(
    (nube.platformLinks ?? []).filter((l: any) => l.platform === PLATFORM).map((l: any) => l.platformId), [PLATFORM_ID],
    'y conserva el link real: una marca manual no tiene links que tocar',
  );
  const pv: any = await central.PlatformVideoModel.findOne({ userId: USER_ID, platform: PLATFORM, platformId: PLATFORM_ID }).lean();
  assert.equal(String(pv?.linkedFileId), String(archivo._id), 'platformvideos: el vínculo sigue');
  const espejo = await espejoDe(PLATFORM_ID);
  assert.deepEqual(
    [espejo?.link_state, espejo?.content_id, espejo?.link_version],
    [espejoAntes?.link_state ?? 'linked', contentId, espejoAntes?.link_version],
    'y el espejo de vínculos no cambia',
  );
});

test('MARK_PUBLISHED — desde descartado, también la saca de descartadas en backup_files', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const d = await postTransicion({
    contentId, platform: OTRA, action: 'discard', operationId: 'op-mp-bd', baseVersion: await revisionDe(contentId, OTRA),
  });
  assert.equal(d.status, 200, 'precondición: el descarte se aplicó');
  const antes: any = await central.BackupFileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.ok((antes.platforms_discarded ?? []).includes(OTRA), 'precondición: backup_files la tiene descartada');

  const r = await marcarPublicado(contentId, 'op-mp-bd-2');
  assert.equal(r.status, 200, 'precondición: se aplicó');

  const backup: any = await central.BackupFileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.deepEqual(
    [(backup.platforms_discarded ?? []).includes(OTRA), backup.platforms.includes(OTRA)], [false, true],
    'backup_files quedó publicada Y descartada a la vez: la marca la agregó a publicadas pero no la ' +
    'sacó de descartadas. Es la proyección que empujan y leen las PCs.',
  );
});

/**
 * Como `conIntercaladoEn`, pero en la primera llamada cuyos argumentos cumplan
 * `esEsta`: con varias escrituras del mismo modelo en la misma operación, hace
 * falta elegir en cuál entra el otro escritor. La elección mira solo el cambio
 * que se aplica, nunca el guard: si no, una mutante que saca el guard evitaría
 * el intercalado en vez de perder contra él.
 */
function conIntercaladoCuando(
  modelo: any, metodo: string, esEsta: (...args: any[]) => boolean, intercalar: () => Promise<void>,
) {
  const original = modelo[metodo];
  let hecho = false;
  modelo[metodo] = function (...args: any[]) {
    if (!hecho && esEsta(...args)) {
      hecho = true;
      modelo[metodo] = original;   // el intercalado usa el método de verdad
      return (async () => { await intercalar(); return original.apply(modelo, args); })();
    }
    return original.apply(modelo, args);
  };
  return {
    restore: () => { modelo[metodo] = original; },
    get hecho() { return hecho; },
  };
}

/**
 * `mark_published` ya pasó su CAS; justo antes de que escriba su alta en UNA
 * proyección, el usuario descarta la plataforma con la revisión nueva.
 */
async function marcarConDescarteIntercalado(modelo: any, esEsta: (...args: any[]) => boolean, op: string) {
  const { contentId } = await sembrarConfirmado();
  const espia = conIntercaladoCuando(modelo, 'updateOne', esEsta, async () => {
    const r = await postTransicion({
      contentId, platform: OTRA, action: 'discard', operationId: `${op}-descarte`,
      baseVersion: await revisionDe(contentId, OTRA),
    });
    assert.equal(r.status, 200, 'precondición: el descarte se aplicó');
  });
  try {
    await marcarPublicado(contentId, op);
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el descarte se intercaló de verdad');
  return contentId;
}

test('MARK_PUBLISHED — un descarte que entra antes de su alta en files no queda pisado', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const contentId = await marcarConDescarteIntercalado(
    central.FileModel, (_f: any, u: any) => u?.$addToSet?.platform_states?.state === 'badge_only', 'op-mp-carrera-file',
  );
  const file: any = await central.FileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.deepEqual(
    [file.platforms.includes(OTRA), (file.platforms_discarded ?? []).includes(OTRA)], [false, true],
    'La marca escribió su alta en files sobre el descarte que entró después de su CAS: la plataforma ' +
    'queda publicada y descartada a la vez. El alta tiene que ir contra la revisión que reclamó.',
  );
});

test('MARK_PUBLISHED — un descarte que entra antes de su alta en backup_files no queda pisado', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const contentId = await marcarConDescarteIntercalado(
    central.BackupFileModel, (_f: any, u: any) => u?.$addToSet?.platforms === OTRA, 'op-mp-carrera-backup',
  );
  const backup: any = await central.BackupFileModel.findOne({ userId: USER_ID, content_id: contentId }).lean();
  assert.deepEqual(
    [backup.platforms.includes(OTRA), (backup.platforms_discarded ?? []).includes(OTRA)], [false, true],
    'La marca escribió su alta en backup_files sobre el descarte que entró después de su CAS. El alta ' +
    'tiene que ir contra la revisión que reclamó.',
  );
});

test('MARK_PUBLISHED — un descarte que entra antes de su alta en Nube no queda pisado', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const contentId = await marcarConDescarteIntercalado(
    central.RemoteLibraryVideoModel, (_f: any, u: any) => u?.$addToSet?.platformStates?.state === 'badge_only',
    'op-mp-carrera-nube',
  );
  const nube: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  assert.deepEqual(
    [nube.platforms.includes(OTRA), (nube.platformsDiscarded ?? []).includes(OTRA)], [false, true],
    'La marca escribió su alta en Nube sobre el descarte que entró después de su CAS. El alta tiene ' +
    'que ir contra la revisión que reclamó.',
  );
});

// ---------------------------------------------------------------------------
// P0 — el espejo que escribe un publish: reasignación viva y timestamps.
// ---------------------------------------------------------------------------

test('P0 — publicar sobre B un vínculo vivo en A lo reasigna, sube su revisión y mueve su reloj', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId: A } = await sembrarConfirmado();
  // Soltar y volver a publicar deja la fila con revisión propia y reloj.
  const u = await postTransicion({
    contentId: A, platform: PLATFORM, action: 'unlink', operationId: 'p0-reasigna-vivo', baseVersion: await revisionDe(A),
  });
  assert.equal(u.status, 200, 'precondición: el unlink se aplicó');
  await central.applyPlatformPublish(USER_ID, {
    contentId: A, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-09T10:00:00.000Z'),
  });
  const antes = await espejoDe(PLATFORM_ID);
  assert.deepEqual([antes?.link_state, antes?.content_id], ['linked', A], 'precondición: vivo en A');
  assert.ok(typeof antes?.link_version === 'number' && antes?.link_updated_at, 'precondición: con revisión y reloj');

  // Que un reloj movido se note aunque la máquina sea rápida.
  await new Promise(r => setTimeout(r, 20));
  const B = 'dddddddd-eeee-ffff-0000-111111111111';
  await central.applyPlatformPublish(USER_ID, {
    contentId: B, platform: PLATFORM, platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    fileName: 'otro video.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
  });

  const despues = await espejoDe(PLATFORM_ID);
  assert.deepEqual([despues?.link_state, despues?.content_id], ['linked', B], 'precondición: vivo en B');
  assert.ok(
    (despues?.link_version ?? 0) > antes!.link_version!,
    `El vínculo pasó de A a B sin subir su revisión (${despues?.link_version} contra ${antes?.link_version}): ` +
    'un dispositivo que ya lo tiene en A compara, lo ve igual, y nunca se entera de la reasignación.',
  );
  assert.ok(
    new Date(despues!.link_updated_at!).getTime() > new Date(antes!.link_updated_at!).getTime(),
    'y su reloj no se movió: cambiar el vínculo es cambiar el vínculo, venga de A o de una lápida',
  );
});

test('P0 — el espejo que escribe un publish cumple el contrato de timestamps del modelo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const NUEVO = '17555555555555551';
  const publicar = () => central.applyPlatformPublish(USER_ID, {
    contentId, platform: PLATFORM, platformId: NUEVO, platformUrl: 'https://www.instagram.com/reel/NUEVO/',
    fileName: 'video integral.mp4', matchStatus: 'manual', publishedAt: new Date('2026-09-10T10:00:00.000Z'),
  });
  await publicar();
  const creada = await espejoDe(NUEVO);
  assert.ok(
    creada?.createdAt instanceof Date && creada?.updatedAt instanceof Date,
    `El documento nuevo del espejo nace sin createdAt/updatedAt (${creada?.createdAt}, ${creada?.updatedAt}): ` +
    'el modelo declara `timestamps: true`, y un documento que no lo cumple es otra variante legada ' +
    'desde su primer día.',
  );

  await new Promise(r => setTimeout(r, 20));
  await publicar();
  const despues = await espejoDe(NUEVO);
  assert.equal(despues?.createdAt?.getTime(), creada?.createdAt?.getTime(), 'una escritura posterior conserva createdAt');
  assert.ok(despues!.updatedAt!.getTime() > creada!.updatedAt!.getTime(), 'y avanza updatedAt');
});

test('P0 — sellar el espejo en la reparación cumple el contrato de timestamps del modelo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const op = 'p0-lv-reparar-timestamps';
  await transicionSuperadaAMitad(contentId, op);
  await central.BackupPlatformVideoModel.deleteOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID });
  await pushDePC({ platform_id: PLATFORM_ID, content_id: contentId, platform_url: null, local_updated_at: '2026-09-09T15:00:00.000Z' });
  const antes = await espejoDe(PLATFORM_ID);
  assert.ok(antes?.createdAt instanceof Date && antes?.updatedAt instanceof Date, 'precondición: la fila tiene timestamps');

  await new Promise(r => setTimeout(r, 20));
  const { repararTransicionesPendientes } = await import('../services/transition-repair.service');
  await vencerLease(op);
  await repararTransicionesPendientes();
  assert.equal((await registroDe(op))?.status, 'superseded', 'precondición: la reparación se cerró');

  const despues = await espejoDe(PLATFORM_ID);
  assert.equal(despues?.link_file_rev, await revisionDe(contentId), 'precondición: la reparación la selló');
  assert.equal(despues?.createdAt?.getTime(), antes?.createdAt?.getTime(), 'sellar conserva createdAt');
  assert.ok(despues!.updatedAt!.getTime() > antes!.updatedAt!.getTime(), 'y avanza updatedAt');
});

// ---------------------------------------------------------------------------
// NUBE — la proyección de una publicación encuentra EL video correcto.
//
// `resolveOrCreateFile` ya resuelve la identidad con el `remoteLibraryVideoId`,
// pero la proyección final a Nube de `applyPlatformPublish` volvía a buscar el
// video por el `contentId` del request -- que iOS no manda -- o por el nombre.
// Y si esa plataforma ya estaba `confirmed`, no tocaba el link. Por eso iOS
// todavía le escribe el link a Nube por su cuenta: un escritor duplicado.
// ---------------------------------------------------------------------------

const PUBLICADO_EL = '2026-09-10T10:00:00.000Z';

/** `POST /api/sync/record-publish`, como lo manda iOS después de una subida real. */
async function publicarDesdeElTelefono(body: Record<string, any>) {
  const { res, captured } = fakeRes();
  await central.recordUploadEvent(
    {
      user: USER, headers: { authorization: AUTH }, params: {}, query: {},
      body: { source: 'ios', platform: PLATFORM, publishedAt: PUBLICADO_EL, ...body },
    } as any,
    res as any,
  );
  return captured;
}

async function videoDeNube(fileName: string, extra: Record<string, any> = {}) {
  return central.RemoteLibraryVideoModel.create({
    userId: USER_ID, fileName, storedFileName: 'stored.mp4', sizeBytes: 1,
    platforms: [], platformsDiscarded: [], ...extra,
  });
}

async function linksEnNube(id: any): Promise<string[]> {
  const doc: any = await central.RemoteLibraryVideoModel.findById(id).lean();
  return (doc?.platformLinks ?? []).filter((l: any) => l.platform === PLATFORM).map((l: any) => l.platformId);
}

async function estadosEnNube(id: any): Promise<string[]> {
  const doc: any = await central.RemoteLibraryVideoModel.findById(id).lean();
  return (doc?.platformStates ?? []).filter((s: any) => s.platform === PLATFORM).map((s: any) => s.state);
}

test('NUBE — una publicación encuentra el video de Nube por su id remoto aunque el nombre difiera', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // El teléfono bajó el video de Nube y lo tiene con otro nombre. Y hay OTRO
  // video en Nube que se llama justo como el archivo local.
  const correcto = await videoDeNube('subido desde el celular.mp4');
  const homonimo = await videoDeNube('clip renombrado.mp4');
  const ID = '17900000000000001';

  const r = await publicarDesdeElTelefono({
    fileName: 'clip renombrado.mp4', remoteLibraryVideoId: String(correcto._id),
    platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');

  assert.deepEqual(
    await linksEnNube(correcto._id), [ID],
    'La proyección a Nube buscó el video por nombre. El teléfono mandó el id remoto -- que es la ' +
    'identidad, y que `resolveOrCreateFile` ya usa --, y el link no llegó al video que se publicó.',
  );
  assert.deepEqual(await estadosEnNube(correcto._id), ['confirmed'], 'y queda confirmado ahí');
  assert.deepEqual(
    await linksEnNube(homonimo._id), [],
    'y no le escribe el link a otro video que solo comparte el nombre',
  );
});

test('NUBE — sin id remoto, la encuentra por el contentId ya resuelto antes que por el nombre', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const C = 'ffffffff-0000-1111-2222-333333333333';
  await central.FileModel.create({
    userId: USER_ID, file_name: 'local.mp4', file_path: 'local.mp4', content_id: C,
    status: 'PENDIENTE', platforms: [], platforms_discarded: [],
  });
  const correcto = await videoDeNube('en la nube.mp4', { contentId: C });
  const homonimo = await videoDeNube('local.mp4');
  const ID = '17900000000000002';

  const r = await publicarDesdeElTelefono({
    fileName: 'local.mp4', platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');

  assert.deepEqual(
    await linksEnNube(correcto._id), [ID],
    'El archivo se resolvió a su contentId, y la proyección a Nube lo ignoró: buscó por el `contentId` ' +
    'del request -- que no vino -- y cayó al nombre.',
  );
  assert.deepEqual(await linksEnNube(homonimo._id), [], 'y el homónimo queda como estaba');
});

test('NUBE — una publicación nueva actualiza el link aunque la plataforma ya estuviera confirmada', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const video: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  assert.deepEqual(
    [await linksEnNube(video._id), await estadosEnNube(video._id)], [[PLATFORM_ID], ['confirmed']],
    'precondición: Nube ya tiene Instagram confirmado, con su link',
  );

  // Se republica en Instagram: una publicación real, con otro platformId.
  const NUEVO = '17900000000000003';
  for (let i = 0; i < 2; i++) {
    const r = await publicarDesdeElTelefono({
      fileName: 'video integral.mp4', remoteLibraryVideoId: String(video._id),
      platformId: NUEVO, platformUrl: `https://www.instagram.com/reel/${NUEVO}/`,
    });
    assert.equal(r.status, 200, 'precondición: la publicación se registró');
  }

  assert.deepEqual(
    await linksEnNube(video._id), [NUEVO],
    'Nube se quedó con el link viejo: la proyección no toca una plataforma que ya estaba confirmada. ' +
    'La publicación nueva ya soltó el vínculo anterior en platformvideos; Nube tiene que reflejarla -- ' +
    'una sola vez, aunque el evento se repita.',
  );
  assert.deepEqual(await estadosEnNube(video._id), ['confirmed']);
});

/** Contrapeso: el nombre sigue sirviendo, pero solo como último recurso. */
test('NUBE — sin id remoto ni contentId que coincida, el nombre sigue encontrando el video', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const soloPorNombre = await videoDeNube('solo por nombre.mp4');
  const ID = '17900000000000004';

  const r = await publicarDesdeElTelefono({
    fileName: 'solo por nombre.mp4', platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');

  assert.deepEqual(await linksEnNube(soloPorNombre._id), [ID]);
});

/** Contrapeso: el id remoto es de ESTA cuenta, o no es de nadie. */
test('NUBE — un id remoto de otra cuenta no recibe el link', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const ajeno = await central.RemoteLibraryVideoModel.create({
    userId: new mongoose.Types.ObjectId().toString(), fileName: 'ajeno.mp4',
    storedFileName: 'stored.mp4', sizeBytes: 1, platforms: [], platformsDiscarded: [],
  });
  const ID = '17900000000000005';

  const r = await publicarDesdeElTelefono({
    fileName: 'mio.mp4', remoteLibraryVideoId: String(ajeno._id),
    platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');

  assert.deepEqual(await linksEnNube(ajeno._id), [], 'un video de otra cuenta no se toca');
});

// ---------------------------------------------------------------------------
// NUBE — la proyección de un publish no resucita lo que una transición
// posterior soltó, sobre la MISMA plataforma.
//
// El P0 de Nube de más arriba intercala una transición de OTRA plataforma: cubre
// el lost update entre plataformas. Acá la transición es sobre la misma, y entra
// después de que el publish ya movió FileModel.
// ---------------------------------------------------------------------------

/** El estado de Instagram en el video de Nube de ese contenido. */
async function instagramEnNube(contentId: string) {
  const doc: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  return {
    publicada: (doc?.platforms ?? []).includes(PLATFORM),
    links: (doc?.platformLinks ?? []).filter((l: any) => l.platform === PLATFORM).map((l: any) => l.platformId),
    estados: (doc?.platformStates ?? []).filter((s: any) => s.platform === PLATFORM).map((s: any) => s.state),
    rev: doc?.platformRev?.[PLATFORM],
  };
}

/**
 * Una publicación real con revisión propia -- un link NUEVO sobre un Instagram
 * ya confirmado -- y, justo antes de UNA de sus escrituras en Nube, el usuario
 * suelta el vínculo con la revisión que el publish acaba de ganar.
 */
async function publicarConUnlinkAntesDe(esEsta: (...args: any[]) => boolean, op: string) {
  const { contentId } = await sembrarConfirmado();
  const video: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  const NUEVO = '17900000000000011';
  const revAntes = await revisionDe(contentId);

  const espia = conIntercaladoCuando(central.RemoteLibraryVideoModel, 'updateOne', esEsta, async () => {
    assert.ok((await revisionDe(contentId)) > revAntes, 'precondición: el publish ya ganó su revisión en FileModel');
    const r = await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink', operationId: op, baseVersion: await revisionDe(contentId),
    });
    assert.equal(r.status, 200, 'precondición: el unlink posterior se aplicó');
  });
  try {
    const r = await publicarDesdeElTelefono({
      fileName: 'video integral.mp4', remoteLibraryVideoId: String(video._id),
      platformId: NUEVO, platformUrl: `https://www.instagram.com/reel/${NUEVO}/`,
    });
    assert.equal(r.status, 200, 'precondición: la publicación se registró');
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el unlink se intercaló de verdad');
  return contentId;
}

const MENSAJE_RESUCITA =
  'El publish volvió a poner en Nube el vínculo que un unlink POSTERIOR -- con una revisión mayor -- ' +
  'acababa de soltar. Sus escrituras en Nube no tienen guard de revisión: la transición gana en FileModel ' +
  'y en platformvideos, y Nube queda contradiciéndolos para siempre.';

test('NUBE — un unlink posterior que entra antes de la primera escritura del publish en Nube gana', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const contentId = await publicarConUnlinkAntesDe(
    (_f: any, u: any) => u?.$addToSet?.platforms === PLATFORM, 'op-nube-carrera-1',
  );

  const nube = await instagramEnNube(contentId);
  assert.deepEqual([nube.publicada, nube.links, nube.estados], [false, [], []], MENSAJE_RESUCITA);
  assert.equal(nube.rev, await revisionDe(contentId), 'y Nube queda sellada con la revisión del unlink');
});

test('NUBE — un unlink posterior que entra antes de la segunda escritura del publish en Nube gana', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const contentId = await publicarConUnlinkAntesDe(
    (_f: any, u: any) => !!u?.$addToSet?.platformLinks, 'op-nube-carrera-2',
  );

  const nube = await instagramEnNube(contentId);
  assert.deepEqual([nube.publicada, nube.links, nube.estados], [false, [], []], MENSAJE_RESUCITA);
  assert.equal(nube.rev, await revisionDe(contentId), 'y Nube queda sellada con la revisión del unlink');
});

test('NUBE — un publish sin revisión nueva no reescribe Nube si el estado canónico ya no es el suyo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Instagram ya confirmado con PLATFORM_ID: repetir ESE publish no mueve la
  // revisión (`revGanada` queda `undefined`).
  const { contentId } = await sembrarConfirmado();
  const video: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  const revAntes = await revisionDe(contentId);

  // Justo antes de que la proyección busque el video de Nube -- la SEGUNDA
  // búsqueda por id; la primera es la de `resolveOrCreateFile` --, el usuario
  // suelta el vínculo. Con eso, la revisión que se leyera AHORA ya es la del
  // unlink: solo el estado canónico dice que este publish dejó de ser el vigente.
  let busquedas = 0;
  const espia = conIntercaladoAntesDeLeer(
    central.RemoteLibraryVideoModel, 'findOne', (f: any) => !!f?._id && ++busquedas === 2,
    async () => {
      assert.equal(await revisionDe(contentId), revAntes, 'precondición: el publish no ganó revisión');
      const r = await postTransicion({
        contentId, platform: PLATFORM, action: 'unlink', operationId: 'op-nube-sin-rev', baseVersion: revAntes,
      });
      assert.equal(r.status, 200, 'precondición: el unlink se aplicó');
    },
  );
  try {
    const r = await publicarDesdeElTelefono({
      fileName: 'video integral.mp4', remoteLibraryVideoId: String(video._id),
      platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    });
    assert.equal(r.status, 200, 'precondición: la publicación se registró');
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: el unlink se intercaló antes de la búsqueda en Nube');

  const nube = await instagramEnNube(contentId);
  assert.deepEqual(
    [nube.publicada, nube.links, nube.estados], [false, [], []],
    'Un publish que no ganó revisión reescribió Nube sin comprobar que el estado canónico siguiera siendo ' +
    'el suyo. El guard solo no alcanza: la revisión que hay para comparar ya es la del unlink.',
  );
});

test('NUBE — un publish sin revisión nueva no pisa en Nube el link de otra publicación que entró después', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Se repite el publish de PLATFORM_ID, ya confirmado: sin revisión nueva.
  const { contentId } = await sembrarConfirmado();
  const video: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  const OTRO = '17900000000000012';

  // Antes de que su proyección busque el video de Nube, entra una publicación
  // REAL de otro link en la misma plataforma: el archivo sigue confirmado --
  // ahora con OTRO -- y PLATFORM_ID quedó suelto. Solo mirar el badge diría que
  // el estado canónico sigue siendo el del primer publish.
  let busquedas = 0;
  const espia = conIntercaladoAntesDeLeer(
    central.RemoteLibraryVideoModel, 'findOne', (f: any) => !!f?._id && ++busquedas === 2,
    async () => {
      const r = await publicarDesdeElTelefono({
        fileName: 'video integral.mp4', remoteLibraryVideoId: String(video._id),
        platformId: OTRO, platformUrl: `https://www.instagram.com/reel/${OTRO}/`,
      });
      assert.equal(r.status, 200, 'precondición: la otra publicación se registró');
    },
  );
  try {
    const r = await publicarDesdeElTelefono({
      fileName: 'video integral.mp4', remoteLibraryVideoId: String(video._id),
      platformId: PLATFORM_ID, platformUrl: PLATFORM_URL,
    });
    assert.equal(r.status, 200, 'precondición: la publicación repetida se registró');
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la otra publicación se intercaló antes de la búsqueda en Nube');

  const nube = await instagramEnNube(contentId);
  assert.deepEqual(
    nube.links, [OTRO],
    'El publish repetido pisó en Nube el link de la publicación que entró después. El archivo seguía ' +
    'confirmado, pero con OTRO vínculo: la prueba del estado canónico tiene que mirar que el vínculo de ' +
    'ESTE publish siga puesto, no solo el badge.',
  );
});

// ---------------------------------------------------------------------------
// NUBE — el estado negativo de una plataforma no deja ningún link en Nube.
//
// Con el guard, un unlink posterior bloquea la proyección del publish -- y con
// ella el `$pull` del link que ese publish reemplazaba. El unlink solo retiraba
// de Nube los links de su alcance congelado, así que el reemplazado quedaba
// huérfano: sin badge ni estado, pero con link. En Nube, "desvinculado" o
// "descartado" implica que no queda ningún link de esa plataforma. El alcance
// sigue valiendo para platformvideos y los otros espejos.
// ---------------------------------------------------------------------------

test('NUBE — un unlink que bloquea la proyección de un publish no deja en Nube el link que ese publish reemplazaba', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // Nube tiene el link viejo A (PLATFORM_ID). Un publish intenta reemplazarlo
  // por B, y un unlink posterior entra antes de su primera escritura en Nube.
  const contentId = await publicarConUnlinkAntesDe(
    (_f: any, u: any) => u?.$addToSet?.platforms === PLATFORM, 'op-nube-huerfano',
  );

  const nube = await instagramEnNube(contentId);
  assert.deepEqual([nube.publicada, nube.estados], [false, []], 'precondición: el unlink ganó el badge y el estado');
  assert.ok(!nube.links.includes('17900000000000011'), 'y el link B del publish bloqueado no volvió');
  assert.ok(
    !nube.links.includes(PLATFORM_ID),
    'Nube quedó con el link VIEJO A: el publish que lo reemplazaba quedó bloqueado -- bien --, y el unlink ' +
    'solo retiró los links de su alcance congelado, donde A ya no estaba. Desvinculado en Nube es sin ' +
    'ningún link de esa plataforma.',
  );
});

/** Contrapeso: el guard de revisión sigue protegiendo a una publicación causalmente posterior. */
test('NUBE — una publicación posterior al unlink sobrevive aunque llegue a Nube antes que él', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const video: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
  const C = '17900000000000013';

  // El unlink ya pasó su CAS. Justo antes de su escritura en Nube -- la que no
  // agrega nada: solo retira --, entra una publicación REAL de C: causalmente
  // posterior, y que llega a Nube antes que él.
  const espia = conIntercaladoCuando(
    central.RemoteLibraryVideoModel, 'updateOne', (_f: any, u: any) => !!u?.$pull?.platformLinks && !u?.$addToSet,
    async () => {
      const r = await publicarDesdeElTelefono({
        fileName: 'video integral.mp4', remoteLibraryVideoId: String(video._id),
        platformId: C, platformUrl: `https://www.instagram.com/reel/${C}/`,
      });
      assert.equal(r.status, 200, 'precondición: la publicación posterior se registró');
    },
  );
  try {
    const r = await postTransicion({
      contentId, platform: PLATFORM, action: 'unlink', operationId: 'op-nube-posterior',
      baseVersion: await revisionDe(contentId),
    });
    assert.equal(r.status, 200, 'precondición: el unlink se aplicó');
  } finally {
    espia.restore();
  }
  assert.ok(espia.hecho, 'precondición: la publicación entró entre el CAS del unlink y su escritura en Nube');

  const nube = await instagramEnNube(contentId);
  assert.deepEqual(
    [nube.publicada, nube.links, nube.estados], [true, [C], ['confirmed']],
    'El unlink le borró a Nube una publicación causalmente POSTERIOR: su escritura tiene que ir contra su ' +
    'propia revisión, y la publicación ya dejó una mayor.',
  );
});

/** Contrapeso: "todos los links" es de ESA plataforma, no de todas. */
test('NUBE — un unlink de Instagram no le retira a Nube el link de YouTube', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  await central.applyPlatformPublish(USER_ID, {
    platform: 'youtube', platformId: 'YTNUBEYTNUB',
    platformUrl: 'https://www.youtube.com/shorts/YTNUBEYTNUB',
    contentId, fileName: 'video integral.mp4', matchStatus: 'manual',
    publishedAt: new Date('2026-09-01T10:00:00.000Z'),
  });
  const linksDe = async (platform: string) => {
    const doc: any = await central.RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId }).lean();
    return (doc?.platformLinks ?? []).filter((l: any) => l.platform === platform).map((l: any) => l.platformId);
  };
  assert.deepEqual(await linksDe('youtube'), ['YTNUBEYTNUB'], 'precondición: Nube tiene el link de YouTube');

  const r = await postTransicion({
    contentId, platform: PLATFORM, action: 'unlink', operationId: 'op-nube-otra-plataforma',
    baseVersion: await revisionDe(contentId),
  });
  assert.equal(r.status, 200, 'precondición: el unlink de Instagram se aplicó');

  assert.deepEqual(await linksDe(PLATFORM), [], 'Instagram queda sin links en Nube');
  assert.deepEqual(
    await linksDe('youtube'), ['YTNUBEYTNUB'],
    'El unlink de Instagram le retiró a Nube el link de YouTube: retirar todos los links es de ESA ' +
    'plataforma, no del video entero.',
  );
});

// ---------------------------------------------------------------------------
// NUBE — un video de Nube sin identidad la recibe al resolverse.
//
// `contentId` es opcional en RemoteLibraryVideoModel. `resolveOrCreateFile`
// resuelve -- o genera -- el `content_id` del FileModel, pero no se lo pasaba al
// video de Nube por el que resolvió. Y `applyPlatformTransition` proyecta sobre
// Nube SOLO por `{ userId, contentId }`: ese video nunca recibía un unlink ni un
// discard.
// ---------------------------------------------------------------------------

test('NUBE — un video de Nube sin identidad recibe la del archivo, y un unlink causal lo alcanza', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // 1. Un video de Nube sin `contentId`.
  const sinIdentidad = await videoDeNube('sin identidad.mp4');
  const ID = '17900000000000021';

  // 2. Se publica por su id remoto.
  const r = await publicarDesdeElTelefono({
    fileName: 'sin identidad.mp4', remoteLibraryVideoId: String(sinIdentidad._id),
    platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');
  assert.deepEqual(await linksEnNube(sinIdentidad._id), [ID], 'precondición: Nube recibió la publicación');

  // 3. La identidad que quedó resuelta en FileModel.
  const archivo: any = await central.FileModel.findOne({ userId: USER_ID, file_name: 'sin identidad.mp4' }).lean();
  assert.ok(archivo?.content_id, 'precondición: el archivo tiene identidad');

  // 4. Es la MISMA en el video de Nube.
  const nube: any = await central.RemoteLibraryVideoModel.findById(sinIdentidad._id).lean();
  assert.equal(
    nube?.contentId, archivo.content_id,
    'El video de Nube quedó sin identidad: `resolveOrCreateFile` la generó solo en FileModel. Las ' +
    'transiciones proyectan sobre Nube por `contentId`, así que ningún unlink ni discard lo alcanza.',
  );

  // 5. Un unlink causal por esa identidad...
  const u = await postTransicion({
    contentId: archivo.content_id, platform: PLATFORM, action: 'unlink', operationId: 'op-nube-sin-identidad',
    baseVersion: await revisionDe(archivo.content_id),
  });
  assert.equal(u.status, 200, 'precondición: el unlink se aplicó');

  // 6. ...deja a Nube sin plataforma, estado ni links.
  const despues = await instagramEnNube(archivo.content_id);
  assert.deepEqual(
    [despues.publicada, despues.estados, despues.links], [false, [], []],
    'el unlink tiene que llegar al video de Nube por su identidad',
  );
});

// ---------------------------------------------------------------------------
// NUBE — una identidad estable no se cambia por un nombre.
// ---------------------------------------------------------------------------

/** El archivo de ese contenido, con lo que la publicación le dejó (o no). */
async function archivoConPublicacion(filtro: Record<string, any>) {
  const f: any = await central.FileModel.findOne({ userId: USER_ID, ...filtro }).lean();
  return f && {
    _id: String(f._id),
    content_id: f.content_id,
    publicada: (f.platforms ?? []).includes(PLATFORM),
    estados: (f.platform_states ?? []).filter((s: any) => s.platform === PLATFORM).map((s: any) => s.state),
  };
}

test('NUBE — un id remoto con identidad X no termina vinculado por nombre a un archivo con otra identidad', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // El video de Nube es X. No hay File(X), pero hay un archivo HOMÓNIMO del
  // nombre local, con otra identidad: Y.
  const X = '78787878-9090-1212-3434-565656565656';
  const Y = '90909090-1212-3434-5656-787878787878';
  const video = await videoDeNube('en la nube.mp4', { contentId: X });
  await central.FileModel.create({
    userId: USER_ID, file_name: 'homonimo.mp4', file_path: 'homonimo.mp4', content_id: Y,
    status: 'PENDIENTE', platforms: [], platforms_discarded: [],
  });
  const ID = '17900000000000031';

  const r = await publicarDesdeElTelefono({
    fileName: 'homonimo.mp4', remoteLibraryVideoId: String(video._id),
    platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');

  const deX = await archivoConPublicacion({ content_id: X });
  assert.ok(
    deX,
    'No hay File(X): la publicación se resolvió POR NOMBRE a otro archivo. El id remoto apunta a un video ' +
    'con identidad X, y esa identidad es estable: si File(X) no existe, se crea por X.',
  );
  assert.deepEqual([deX.publicada, deX.estados], [true, ['confirmed']], 'y es File(X) el que recibe la publicación');
  const pv: any = await central.PlatformVideoModel.findOne({ userId: USER_ID, platform: PLATFORM, platformId: ID }).lean();
  assert.equal(String(pv?.linkedFileId), deX._id, 'con el vínculo en platformvideos');

  const deY = await archivoConPublicacion({ content_id: Y });
  assert.deepEqual(
    [deY?.publicada, deY?.estados], [false, []],
    'El homónimo Y recibió la publicación: comparte el nombre, no la identidad.',
  );
  assert.deepEqual(await linksEnNube(video._id), [ID], 'y Nube la recibe en el video X');
});

test('NUBE — ni por el nombre que el video tiene en Nube: una identidad estable no adopta un archivo con otra', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // El video de Nube es X y se llama "nombre en nube.mp4". El teléfono tiene el
  // archivo con otro nombre. Y hay un archivo que se llama como el video de
  // Nube, con otra identidad: Y.
  const X = '13131313-2424-3535-4646-575757575757';
  const Y = '24242424-3535-4646-5757-686868686868';
  const video = await videoDeNube('nombre en nube.mp4', { contentId: X });
  await central.FileModel.create({
    userId: USER_ID, file_name: 'nombre en nube.mp4', file_path: 'nombre en nube.mp4', content_id: Y,
    status: 'PENDIENTE', platforms: [], platforms_discarded: [],
  });
  const ID = '17900000000000033';

  const r = await publicarDesdeElTelefono({
    fileName: 'nombre local.mp4', remoteLibraryVideoId: String(video._id),
    platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');

  const deX = await archivoConPublicacion({ content_id: X });
  assert.deepEqual(
    [deX?.publicada, deX?.estados], [true, ['confirmed']],
    'La publicación se resolvió por el nombre que el video tiene en Nube, a un archivo con otra identidad. ' +
    'Si File(X) no existe, se crea por X.',
  );
  const deY = await archivoConPublicacion({ content_id: Y });
  assert.deepEqual([deY?.publicada, deY?.estados], [false, []], 'y el archivo homónimo del nombre de Nube queda intacto');
  assert.deepEqual(await linksEnNube(video._id), [ID], 'y Nube la recibe en el video X');
});

test('NUBE — la proyección no escribe en un video de Nube cuya identidad no es la del archivo', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // El cliente declara el contenido Z, y a la vez un id remoto cuyo video es
  // X: datos del cliente que no coinciden. La publicación va al archivo que el
  // cliente declaró; el video de Nube de OTRA identidad no se toca -- ni por
  // su id, ni porque se llame igual que el archivo.
  const X = 'abababab-cdcd-efef-0101-232323232323';
  const Z = 'cdcdcdcd-efef-0101-2323-454545454545';
  const video = await videoDeNube('archivo Z.mp4', { contentId: X });
  await central.FileModel.create({
    userId: USER_ID, file_name: 'archivo Z.mp4', file_path: 'archivo Z.mp4', content_id: Z,
    status: 'PENDIENTE', platforms: [], platforms_discarded: [],
  });
  const ID = '17900000000000032';

  const r = await publicarDesdeElTelefono({
    fileName: 'archivo Z.mp4', contentId: Z, remoteLibraryVideoId: String(video._id),
    platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');

  const deZ = await archivoConPublicacion({ content_id: Z });
  assert.deepEqual([deZ?.publicada, deZ?.estados], [true, ['confirmed']], 'precondición: File(Z) recibió la publicación');
  const nube: any = await central.RemoteLibraryVideoModel.findById(video._id).lean();
  assert.deepEqual(
    [nube?.contentId, await linksEnNube(video._id), await estadosEnNube(video._id)], [X, [], []],
    'La proyección escribió la publicación de Z en el video de Nube X, solo porque el cliente mandó su id. ' +
    'Nube se proyecta sobre el video de la MISMA identidad que el archivo.',
  );
});

/** Contrapeso: el backfill completa una identidad que falta, nunca pisa una que ya está. */
test('NUBE — el backfill no pisa la identidad que el video de Nube ya tiene', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  // El video de Nube lleva X; FileModel no conoce X, y resuelve por nombre a un
  // archivo con otra identidad, Y.
  const X = '12121212-3434-5656-7878-909090909090';
  const Y = '34343434-5656-7878-9090-121212121212';
  const video = await videoDeNube('con identidad.mp4', { contentId: X });
  await central.FileModel.create({
    userId: USER_ID, file_name: 'otro nombre.mp4', file_path: 'otro nombre.mp4', content_id: Y,
    status: 'PENDIENTE', platforms: [], platforms_discarded: [],
  });
  const ID = '17900000000000022';

  const r = await publicarDesdeElTelefono({
    fileName: 'otro nombre.mp4', remoteLibraryVideoId: String(video._id),
    platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.equal(r.status, 200, 'precondición: la publicación se registró');

  const nube: any = await central.RemoteLibraryVideoModel.findById(video._id).lean();
  assert.equal(
    nube?.contentId, X,
    'El backfill le pisó al video de Nube la identidad que ya tenía: tiene que completar una que falta, ' +
    'nunca reemplazar una que está.',
  );
});

/**
 * Una colisión con el índice único es un CONFLICTO, no una advertencia.
 *
 * Reemplaza al contrapeso de 9f41fb2, que afirmaba lo contrario: que la
 * publicación seguía con 200 y el backfill solo se salteaba. Así, el link
 * terminaba escrito en un video de Nube sin identidad -- que ninguna transición
 * alcanza -- o en el otro, que no es el que el cliente declaró.
 */
test('NUBE — si otro video de Nube ya tiene esa identidad, la publicación es un conflicto: no escribe nada y conserva la intención', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const Y = '56565656-7878-9090-1212-343434343434';
  const sinIdentidad = await videoDeNube('sin identidad 2.mp4');
  const yaLaTiene = await videoDeNube('el que ya la tiene.mp4', { contentId: Y });
  await central.FileModel.create({
    userId: USER_ID, file_name: 'sin identidad 2.mp4', file_path: 'sin identidad 2.mp4', content_id: Y,
    status: 'PENDIENTE', platforms: [], platforms_discarded: [],
  });
  const ID = '17900000000000023';

  const r = await publicarDesdeElTelefono({
    fileName: 'sin identidad 2.mp4', remoteLibraryVideoId: String(sinIdentidad._id),
    platformId: ID, platformUrl: `https://www.instagram.com/reel/${ID}/`,
  });
  assert.notEqual(
    r.status, 200,
    'La publicación respondió 200 con dos videos de Nube reclamando la misma identidad: el del id declarado ' +
    'no la puede recibir, y el que la tiene no es el que el cliente declaró. Es ambiguo: conflicto.',
  );
  assert.equal(r.status, 409, 'un conflicto estructurado');
  assert.deepEqual(
    [r.body?.reason, r.body?.remoteLibraryVideoId, r.body?.contentId, r.body?.conflictingRemoteLibraryVideoId],
    ['remote_identity_conflict', String(sinIdentidad._id), Y, String(yaLaTiene._id)],
    'que dice qué video, qué identidad y con cuál choca',
  );

  // Nada escrito en ninguno de los documentos ambiguos.
  for (const [nombre, id] of [['el del id declarado', sinIdentidad._id], ['el que ya tiene la identidad', yaLaTiene._id]] as const) {
    const doc: any = await central.RemoteLibraryVideoModel.findById(id).lean();
    assert.deepEqual(
      [(doc?.platforms ?? []).includes(PLATFORM), await estadosEnNube(id), await linksEnNube(id)], [false, [], []],
      `Nube (${nombre}): sin badge, sin estado y sin link`,
    );
  }
  const a: any = await central.RemoteLibraryVideoModel.findById(sinIdentidad._id).lean();
  assert.equal(a?.contentId ?? null, null, 'el del id declarado sigue sin identidad');
  const deY = await archivoConPublicacion({ content_id: Y });
  assert.deepEqual([deY?.publicada, deY?.estados], [false, []], 'File(Y): sin badge ni estado');
  assert.equal(
    await central.PlatformVideoModel.countDocuments({ userId: USER_ID, platform: PLATFORM, platformId: ID }), 0,
    'ni vínculo en platformvideos',
  );
  assert.equal(
    await central.BackupPlatformVideoModel.countDocuments({ userId: USER_ID, platform: PLATFORM, platform_id: ID }), 0,
    'ni fila en el espejo que leen las PCs',
  );

  // La intención queda, para diagnóstico y reconciliación.
  const { AuditEventModel } = await import('../models/audit-event.model');
  const intencion: any = await AuditEventModel.findOne({ userId: USER_ID, type: 'publish_conflict', 'entity.id': ID }).lean();
  assert.ok(intencion, 'La publicación en conflicto se perdió: tiene que quedar registrada la intención.');
  assert.deepEqual(
    [intencion.platform, intencion.detail?.remoteLibraryVideoId, intencion.detail?.contentId,
      intencion.detail?.conflictingRemoteLibraryVideoId, intencion.detail?.platformUrl],
    [PLATFORM, String(sinIdentidad._id), Y, String(yaLaTiene._id), `https://www.instagram.com/reel/${ID}/`],
    'con lo necesario para reconciliarla',
  );
});

