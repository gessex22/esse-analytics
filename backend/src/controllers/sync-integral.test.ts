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

interface Router {
  calls: string[];
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

      if (method === 'POST' && p === '/api/backup/files/bulk') return await dispatch(central.bulkUpsertBackupFiles, { body });
      if (method === 'GET' && p === '/api/backup/files') return await dispatch(central.getBackupFiles, { query });
      if (method === 'POST' && p === '/api/backup/platform-videos/bulk') return await dispatch(central.bulkUpsertBackupPlatformVideos, { body });
      if (method === 'GET' && p === '/api/backup/platform-videos') return await dispatch(central.getBackupPlatformVideos, {});
      if (method === 'GET' && p === '/api/backup/config') return await dispatch(central.getBackupConfig, {});
      if (method === 'POST' && p === '/api/backup/config') return await dispatch(central.upsertBackupConfig, { body });
      if (method === 'POST' && (p === '/api/sync/history' || p === '/api/sync/record-publish')) {
        return await dispatch(central.recordUploadEvent, { body });
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
  const waitIdle = async () => {
    for (let intento = 0; intento < 100; intento++) {
      await new Promise(r => setImmediate(r));
      if (pending === 0) {
        await new Promise(r => setImmediate(r));
        if (pending === 0) return;
      }
    }
    throw new Error('el push de fondo no terminó nunca: sigue habiendo fetch en vuelo');
  };

  return { calls, unknown, waitIdle, restore: () => { globalThis.fetch = original; } };
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

  assert.deepEqual(
    [a.status, b.status], [200, 200],
    'Las dos entregas de la MISMA operación tienen que responder OK. Un 409 significa "tu operación ' +
    'quedó vieja", que es otra cosa: una outbox que lo lea puede creer que se perdió y armar una nueva.',
  );
  assert.ok(
    [a.body?.deduplicated, b.body?.deduplicated].includes(true),
    'y una de las dos tiene que declararse deduplicada',
  );
  assert.equal(await revisionDe(contentId), rev0 + 1, 'los efectos se aplican una sola vez');
});
