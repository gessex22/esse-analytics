// Harness INTEGRAL de convergencia — paso 5 de la Entrega 1
// (docs/sync-convergence-plan-2026-09-08.md).
//
// A diferencia de sync-convergence.test.ts, que prueba tramos sueltos con la
// respuesta de la central simulada, acá NO se hardcodea ninguna respuesta: el
// `fetch` que sale de local-backend se enruta a los CONTROLADORES REALES de la
// central, en el mismo proceso. Electron habla con la central de verdad; lo
// único falso es el transporte HTTP.
//
// Esto lo convierte en el CONTRATO que la implementación debe cumplir, no en
// una reproducción del incidente: los casos de abajo describen cómo tiene que
// comportarse el sistema, y varios están ROJOS porque todavía no se implementó
// (tombstone, outbox, precedencia por orden).
//
// REQUIERE Mongo local descartable (Docker). Sin él, SKIP -- nunca falla por
// infraestructura ausente.
//
// Correr:  cd backend && npx tsx --test src/controllers/sync-integral.test.ts

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
const USER_ID = new mongoose.Types.ObjectId().toString();
const AUTH = 'Bearer token-de-prueba';
const USER = { id: USER_ID, username: 'tester', role: 'editor', tier: 'free', hasCloudStorage: false };

// ---------------------------------------------------------------------------
// Transporte: enruta el fetch de local-backend a los controladores reales.
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

/** Ejecuta un handler de la central y devuelve una Response HTTP real. */
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

let central: any;

/**
 * Reemplaza globalThis.fetch por un router hacia la central real. Devuelve el
 * log de llamadas, para poder afirmar sobre lo que Electron intentó hacer.
 */
function routeToCentral(): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: any, init?: any) => {
    const raw = typeof input === 'string' ? input : String(input?.url ?? input);
    const url = new URL(raw);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push(`${method} ${url.pathname}`);

    const p = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());

    if (method === 'POST' && p === '/api/backup/files/bulk') {
      return dispatch(central.bulkUpsertBackupFiles, { body });
    }
    if (method === 'GET' && p === '/api/backup/files') {
      return dispatch(central.getBackupFiles, { query });
    }
    if (method === 'POST' && p === '/api/backup/platform-videos/bulk') {
      return dispatch(central.bulkUpsertBackupPlatformVideos, { body });
    }
    if (method === 'GET' && p === '/api/backup/platform-videos') {
      return dispatch(central.getBackupPlatformVideos, {});
    }
    if (method === 'GET' && p === '/api/backup/config') {
      return dispatch(central.getBackupConfig, {});
    }
    if (method === 'POST' && p === '/api/backup/config') {
      return dispatch(central.upsertBackupConfig, { body });
    }
    if (method === 'DELETE' && p.startsWith('/api/sync/platform-link/')) {
      const [, , , , contentId, platform] = p.split('/');
      return dispatch(central.unlinkPlatform, {
        params: { contentId: decodeURIComponent(contentId), platform },
      });
    }
    if (method === 'POST' && (p === '/api/sync/history' || p === '/api/sync/record-publish')) {
      return dispatch(central.recordUploadEvent, { body });
    }

    // Rutas que no son objeto de este harness (transcripts, calendario, etc.):
    // responden vacío para no romper el flujo, y quedan en `calls` por si hace
    // falta afirmar sobre ellas.
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function conectarOSaltear(t: any): Promise<boolean> {
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(MONGO_URI) || MONGO_URI.includes('@')) {
    throw new Error('MONGO_TEST_URI debe ser un Mongo local descartable.');
  }
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000, autoIndex: false });
    await mongoose.connection.dropDatabase();
    return true;
  } catch {
    t.skip(`No hay Mongo local en ${MONGO_URI}. Levantá el contenedor para correr el harness integral.`);
    return false;
  }
}

const PLATFORM = 'instagram';
const PLATFORM_ID = '17999999999999999';
const PLATFORM_URL = 'https://www.instagram.com/reel/AAAAAAAAAAA/';

/**
 * Siembra el MISMO video, publicado y confirmado, en las 6 representaciones:
 * SQLite (files + platform_videos) y Mongo (files, backup_files,
 * platformvideos, backup_platform_videos, remote_library_videos).
 */
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

  return { local, contentId, centralFileId: centralFile._id };
}

/** Un ciclo de sincronización completo, igual que runSyncTick: push y después pull. */
async function cicloSync() {
  const { pushFilesToCloud, pullFromCloud } = await import('../../../local-backend/src/controllers/backup-sync.controller');
  await pushFilesToCloud(AUTH);
  const { res } = fakeRes();
  await pullFromCloud({ headers: { authorization: AUTH } } as any, res as any);
}

/** Foto del estado en las 6 representaciones, para afirmar de una. */
async function fotoDelEstado(contentId: string) {
  const { fileRepo } = await import('../../../local-backend/src/db/file.repo');
  const { db } = await import('../../../local-backend/src/db/database');

  const localFile = fileRepo.findByContentId(contentId)!;
  const localLink = db
    .prepare(`SELECT platform, platform_id, linked_file_id FROM platform_videos WHERE platform = ? AND linked_file_id = ?`)
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

after(async () => {
  const { db } = await import('../../../local-backend/src/db/database');
  if (db.open) db.close();
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// CASO 1 — Un descarte explícito sobrevive tres ciclos completos.
// Reemplaza al test viejo, que hardcodeaba la respuesta defectuosa de la nube y
// por lo tanto habría seguido rojo aunque el bug se arreglara.
// ---------------------------------------------------------------------------
test('INTEGRAL — un unlink explícito sobrevive 3 ciclos push/pull en las 6 representaciones', async (t) => {
  if (!(await conectarOSaltear(t))) return;
  central = await import('./backup.controller').then(async (backup) => ({
    ...backup,
    ...(await import('./sync.controller')),
    FileModel: (await import('../models/file.model')).FileModel,
    BackupFileModel: (await import('../models/backup-file.model')).BackupFileModel,
    PlatformVideoModel: (await import('../models/platform-video.model')).PlatformVideoModel,
    BackupPlatformVideoModel: (await import('../models/backup-platform-video.model')).BackupPlatformVideoModel,
    RemoteLibraryVideoModel: (await import('../models/remote-library-video.model')).RemoteLibraryVideoModel,
  }));

  const { setPlatformLink } = await import('../../../local-backend/src/controllers/video.controller');
  const { local, contentId } = await sembrarConfirmado();

  const t0 = await fotoDelEstado(contentId);
  assert.deepEqual(t0.sqlite.platforms, [PLATFORM], 'precondición: arranca publicado');
  assert.ok(t0.mirror, 'precondición: el espejo tiene la fila');

  const router = routeToCentral();
  try {
    // El usuario borra el link en Electron.
    const { res } = fakeRes();
    await setPlatformLink(
      { params: { fileId: String(local.id), platform: PLATFORM }, body: { url: '' }, headers: { authorization: AUTH } } as any,
      res as any,
    );

    for (let i = 1; i <= 3; i++) {
      await cicloSync();
      const foto = await fotoDelEstado(contentId);

      assert.deepEqual(foto.sqlite.platforms, [], `ciclo ${i}: SQLite no debe recuperar el badge`);
      assert.equal(foto.sqlite.link, null, `ciclo ${i}: SQLite no debe recuperar el link`);
      assert.deepEqual(foto.files.platforms, [], `ciclo ${i}: files no debe recuperar el badge`);
      assert.deepEqual(foto.backupFiles.platforms, [], `ciclo ${i}: backup_files no debe recuperar el badge`);
      assert.equal(foto.platformVideo.linkedFileId, null, `ciclo ${i}: el link real debe seguir desvinculado`);
      assert.deepEqual(foto.remote.platforms, [], `ciclo ${i}: Nube no debe recuperar el badge`);
      assert.deepEqual(foto.remote.links, [], `ciclo ${i}: Nube no debe recuperar el link`);
    }
  } finally {
    router.restore();
  }
});

// ---------------------------------------------------------------------------
// CASO 2 — Una segunda PC tiene que enterarse del unlink.
//
// ROJO ESPERADO hasta implementar el tombstone: hoy el servicio BORRA la fila
// de backup_platform_videos, y `pullPlatformVideosFromCloud` no elimina nunca
// filas locales ausentes de la respuesta (verificado: cero eliminaciones). Una
// segunda PC que ya tenía el link se lo queda para siempre.
//
// Se simula sobre la misma SQLite re-insertando la fila vieja, que es
// exactamente el estado en que quedó esa otra PC, y corriendo SU pull.
// ---------------------------------------------------------------------------
test('INTEGRAL — una segunda PC con el vínculo viejo recibe el tombstone y lo borra', async (t) => {
  if (mongoose.connection.readyState !== 1) { t.skip('sin Mongo'); return; }

  const { platformVideoRepo } = await import('../../../local-backend/src/db/platform-video.repo');
  const { fileRepo } = await import('../../../local-backend/src/db/file.repo');
  const { db } = await import('../../../local-backend/src/db/database');

  const contentId = (db.prepare(`SELECT content_id FROM files LIMIT 1`).get() as any).content_id;
  const localFile = fileRepo.findByContentId(contentId)!;

  // Estado de la "segunda PC": todavía tiene el vínculo que la primera soltó.
  platformVideoRepo.upsert({
    platform: PLATFORM, platform_id: PLATFORM_ID, platform_url: PLATFORM_URL,
    linked_file_id: localFile.id, match_status: 'manual',
  });
  fileRepo.addPlatform(localFile.id, PLATFORM as any);

  const router = routeToCentral();
  try {
    const { pullFromCloud } = await import('../../../local-backend/src/controllers/backup-sync.controller');
    const { res } = fakeRes();
    await pullFromCloud({ headers: { authorization: AUTH } } as any, res as any);
  } finally {
    router.restore();
  }

  const linkTrasPull = db
    .prepare(`SELECT platform FROM platform_videos WHERE platform = ? AND linked_file_id = ?`)
    .get(PLATFORM, localFile.id);

  assert.equal(
    linkTrasPull, undefined,
    'La segunda PC tiene que soltar el vínculo al hacer pull. Hoy no puede: el servicio BORRA la ' +
    'fila del espejo y el pull no elimina nunca filas locales ausentes de la respuesta, así que ' +
    'este dispositivo conserva un link que ya no existe. Hace falta un tombstone.',
  );
});

// ---------------------------------------------------------------------------
// CASO 3 — Una operación vieja que llega tarde no puede destruir una
// publicación nueva.
//
// ROJO ESPERADO: `operationId` da idempotencia, no precedencia. Hace falta una
// regla de orden (base version, o comparar `occurredAt` contra el último cambio
// registrado) para descartar la operación rezagada.
// ---------------------------------------------------------------------------
test('INTEGRAL — un unlink viejo que llega tarde no destruye una publicación posterior', async (t) => {
  if (mongoose.connection.readyState !== 1) { t.skip('sin Mongo'); return; }

  const { applyPlatformTransition } = await import('../services/platform-transition.service');
  const { db } = await import('../../../local-backend/src/db/database');
  const contentId = (db.prepare(`SELECT content_id FROM files LIMIT 1`).get() as any).content_id;

  const momentoDelUnlink = new Date('2026-09-02T10:00:00.000Z');

  // Se vuelve a publicar DESPUÉS de ese momento, con link real.
  await central.applyPlatformPublish(USER_ID, {
    platform: PLATFORM, platformId: '18888888888888888',
    platformUrl: 'https://www.instagram.com/reel/BBBBBBBBBBB/',
    contentId, fileName: 'video integral.mp4',
    publishedAt: new Date('2026-09-05T10:00:00.000Z'), matchStatus: 'manual',
  });

  const antes = await fotoDelEstado(contentId);
  assert.deepEqual(antes.files.platforms, [PLATFORM], 'precondición: la republicación quedó registrada');

  // Ahora llega, con retraso, el unlink de ANTES de esa publicación.
  await applyPlatformTransition(USER_ID, {
    contentId, platform: PLATFORM as any, action: 'unlink',
    // @ts-expect-error -- `occurredAt` es parte del contrato acordado, todavía
    // sin implementar en la firma del servicio. El test lo exige.
    occurredAt: momentoDelUnlink,
  });

  const despues = await fotoDelEstado(contentId);
  assert.deepEqual(
    despues.files.platforms, [PLATFORM],
    'Un unlink anterior a la publicación no debe borrarla al llegar tarde. Hoy el servicio aplica ' +
    'la transición sin mirar el orden: operationId evita duplicados, pero no resuelve precedencia.',
  );
});
