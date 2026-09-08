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
    contentId, platform: PLATFORM, action: 'unlink', baseVersion: revVieja,
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
    contentId, platform: PLATFORM, action: 'unlink', baseVersion: revVieja,
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
