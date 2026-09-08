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
// CASO 3 — una operación vieja que llega tarde no destruye una publicación
// posterior.
//
// ROJO ESPERADO: `operationId` da idempotencia, no precedencia.
//
// La comparación NO puede ser contra `publishedAt`: alguien puede vincular HOY
// una publicación de hace meses, y ahí `publishedAt` es viejo aunque la mutación
// sea nueva. Lo que hay que comparar es cuándo cambió el ESTADO
// (`stateChangedAt` / `baseVersion`). Por eso el seed de abajo usa a propósito
// un publishedAt viejo con una mutación nueva.
// ---------------------------------------------------------------------------
test('INTEGRAL — un unlink viejo que llega tarde no destruye una publicación posterior', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  await cargarCentral();
  await limpiarEstado();

  const { contentId } = await sembrarConfirmado();
  const { applyPlatformTransition } = await import('../services/platform-transition.service');

  // Se republica con un link nuevo. `publishedAt` a propósito VIEJO: es un video
  // antiguo que recién ahora se vincula. Lo nuevo es la mutación, no el video.
  await central.applyPlatformPublish(USER_ID, {
    platform: PLATFORM, platformId: '18888888888888888',
    platformUrl: 'https://www.instagram.com/reel/BBBBBBBBBBB/',
    contentId, fileName: 'video integral.mp4',
    publishedAt: new Date('2026-01-15T10:00:00.000Z'), matchStatus: 'manual',
  });

  const antes = await fotoDelEstado(contentId);
  assert.deepEqual(antes.files.platforms, [PLATFORM], 'precondición: la republicación quedó registrada');

  // Llega tarde el unlink, cuyo CAMBIO DE ESTADO es anterior a la republicación.
  await applyPlatformTransition(USER_ID, {
    contentId, platform: PLATFORM as any, action: 'unlink',
    // @ts-expect-error -- `stateChangedAt` es parte del contrato acordado y
    // todavía no existe en la firma. El test lo exige.
    stateChangedAt: new Date('2026-09-02T10:00:00.000Z'),
  });

  const despues = await fotoDelEstado(contentId);
  assert.deepEqual(
    despues.files.platforms, [PLATFORM],
    'Un unlink cuyo cambio de estado es anterior a la republicación no debe borrarla al llegar ' +
    'tarde. Hoy el servicio aplica la transición sin mirar el orden.',
  );
});
