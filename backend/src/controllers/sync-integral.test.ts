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

  Object.assign(router, { calls, unknown, waitIdle, restore: () => { globalThis.fetch = original; } });
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
// ---------------------------------------------------------------------------
test('P1 — el upsert del tombstone no puede pisar un link con revisión posterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const rev0 = await revisionDe(contentId);

  // Otro dispositivo ya re-vinculó ese platformId, y su escritura -- con una
  // revisión muy posterior -- ya está en el espejo.
  await central.BackupPlatformVideoModel.updateOne(
    { userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID },
    { $set: { link_state: 'linked', link_updated_at: new Date('2026-09-08T20:00:00.000Z'), link_version: 99 } },
  );

  const { applyPlatformTransition } = await import('../services/platform-transition.service');
  await applyPlatformTransition(USER_ID, {
    contentId, platform: PLATFORM as any, action: 'unlink',
    operationId: 'p1-tombstone-sin-guard', baseVersion: rev0,
  });

  const mirror = await central.BackupPlatformVideoModel
    .findOne({ userId: USER_ID, platform: PLATFORM, platform_id: PLATFORM_ID }).lean();

  assert.equal(
    mirror?.link_state, 'linked',
    'El tombstone pisó un re-vínculo posterior. El updateMany compara link_version pero el upsert ' +
    'que viene después no compara nada, así que escribe igual.',
  );
  assert.equal(mirror?.link_version, 99, 'y no puede bajarle la revisión');
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
