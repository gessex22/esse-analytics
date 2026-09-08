// Harness de convergencia — tramo CENTRAL. Complemento de
// local-backend/src/controllers/sync-convergence.test.ts, que cubre los dos
// extremos (Electron y el pull). Acá se prueba el eslabón del medio: el push
// de catálogo re-agregando una plataforma que el usuario acaba de descartar.
//
// ESTE TEST ESTÁ EN ROJO A PROPÓSITO (Entrega 1 del plan, ver
// docs/sync-reconciliation-map-2026-09-08.md). Ejecuta `bulkUpsertBackupFiles`
// de producción tal cual, no una reimplementación de sus reglas.
//
// REQUIERE UN MONGO LOCAL DESCARTABLE (el de Docker, por ejemplo). Si no hay
// ninguno escuchando, el test se SALTEA con un mensaje -- nunca falla por
// infraestructura ausente, para no confundir "no hay Mongo" con "el bug se
// arregló".
//
// Correr:  cd backend && npm test
//          (o: MONGO_TEST_URI=mongodb://127.0.0.1:27017/esse_sync_test npm test)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';

// 127.0.0.1 explícito, no "localhost": en Windows el resolver de Node prueba
// ::1 primero y falla contra servidores que solo escuchan IPv4 -- trampa ya
// documentada en el CLAUDE.md de este repo.
const TEST_URI = process.env.MONGO_TEST_URI ?? 'mongodb://127.0.0.1:27017/esse_sync_test';

// Rail de seguridad: este harness escribe y borra colecciones enteras. Solo
// puede correr contra un Mongo local. Cualquier cosa que huela a un cluster
// remoto (Atlas, credenciales embebidas, SRV) aborta antes de conectar.
function assertUriEsLocalYDescartable(uri: string): void {
  const esLocal = /^mongodb:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?\//.test(uri);
  const pareceRemoto = uri.includes('mongodb+srv://') || uri.includes('@') || uri.includes('mongodb.net');
  if (!esLocal || pareceRemoto) {
    throw new Error(
      `MONGO_TEST_URI debe apuntar a un Mongo local descartable, no a un cluster real. Recibido: ${uri.replace(/\/\/.*@/, '//***@')}`,
    );
  }
}

async function conectarOSaltear(t: any): Promise<boolean> {
  assertUriEsLocalYDescartable(TEST_URI);
  try {
    // autoIndex: false a propósito -- con los índices automáticos, Mongoose
    // recrea las colecciones (vacías) DESPUÉS del dropDatabase() del final,
    // dejando cáscaras en el Mongo del desarrollador. No es fuga de datos,
    // pero ensucia y hace ruido al revisar si el harness limpió bien.
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 2000, autoIndex: false });
    // Arranca de cero aunque una corrida anterior se haya cortado a la mitad.
    await mongoose.connection.dropDatabase();
    return true;
  } catch {
    // Mismo criterio que el harness integral: con ESSE_REQUIRE_MONGO=1 (lo que
    // corre `npm run test:integration` y el pipeline) esto FALLA en vez de
    // saltear. Un skip silencioso deja pasar un merge sin haber probado nada.
    if (process.env.ESSE_REQUIRE_MONGO === '1') {
      throw new Error('ESSE_REQUIRE_MONGO=1 pero no hay Mongo en ' + TEST_URI + '.');
    }
    t.skip(
      `No hay un Mongo local escuchando en ${TEST_URI}. Levantá el contenedor de Docker ` +
      `(o pasá MONGO_TEST_URI) para correr este tramo del harness.`,
    );
    return false;
  }
}

/** req/res falsos, suficientes para bulkUpsertBackupFiles. */
function fakeReqRes(user: any, body: unknown) {
  const req: any = { user, body, headers: {}, query: {}, params: {} };
  const captured: { status: number; payload: any; headers: Record<string, string> } = {
    status: 200, payload: undefined, headers: {},
  };
  const res: any = {
    set(key: string, value: string) { captured.headers[key] = value; return res; },
    status(code: number) { captured.status = code; return res; },
    json(payload: unknown) { captured.payload = payload; return res; },
  };
  return { req, res, captured };
}

// ---------------------------------------------------------------------------
// BUG 2, tramo del medio — el push de catálogo revierte un descarte explícito.
//
// Escenario exacto del informe: el usuario descarta Instagram en Electron sobre
// una plataforma que la central tiene como `confirmed`. El push de catálogo
// llega con el estado correcto (sin badge, en descartados), pero
// `bulkUpsertBackupFiles` le aplica la protección de BUG-2026-09-06-04 --que
// re-agrega toda plataforma `confirmed` y la saca de descartados-- porque NO
// puede distinguir una acción explícita del usuario de un push automático
// atrasado. Esa distinción es justo lo que introduce el punto 0 del plan.
//
// Se pone en verde cuando el descarte explícito pase por el servicio central
// como transición (y el push deje de poder reinterpretarlo).
// ---------------------------------------------------------------------------
test('BUG 2 / tramo central (rojo) — el push de catálogo no debe revertir un descarte explícito', async (t) => {
  if (!(await conectarOSaltear(t))) return;

  const { FileModel } = await import('../models/file.model');
  const { bulkUpsertBackupFiles } = await import('./backup.controller');

  // string, no ObjectId: FileModel.userId está tipado como string en el schema.
  const userId = new mongoose.Types.ObjectId().toString();
  const CONTENT_ID = 'contenido-descarte-central-1';
  const FILE_NAME = 'video descartado en electron.mp4';
  const ANTES = new Date('2026-09-08T11:00:00.000Z');
  const DESPUES = new Date('2026-09-08T12:00:00.000Z');

  try {
    // Estado de partida en la central: Instagram publicada y CONFIRMADA
    // (tiene un link real detrás).
    await FileModel.create({
      userId,
      file_name: FILE_NAME,
      file_path: FILE_NAME,
      content_id: CONTENT_ID,
      status: 'PENDIENTE',
      platforms: ['instagram'],
      platforms_discarded: [],
      platform_states: [{ platform: 'instagram', state: 'confirmed' }],
      platforms_updated_at: ANTES,
    });

    // El push que manda Electron después de que el usuario descartó Instagram:
    // más nuevo que lo que hay en la central, y explícito.
    const { req, res, captured } = fakeReqRes(
      // Usuario común: sin owner ni cloud storage, para que el bloque de
      // sincronización a Nube no entre y el test aísle el badge.
      { id: userId, username: 'tester', role: 'editor', tier: 'free', hasCloudStorage: false },
      {
        files: [{
          content_id: CONTENT_ID,
          file_name: FILE_NAME,
          platforms: [],
          platforms_discarded: ['instagram'],
          platforms_updated_at: DESPUES,
          local_updated_at: DESPUES,
          content_status: 'borrador',
        }],
        video_folder: 'C:/videos',
        fullSync: false,
        deviceId: 'device-de-prueba',
      },
    );

    await bulkUpsertBackupFiles(req, res);
    assert.equal(captured.status, 200, `el push debería responder 200, respondió ${captured.status}`);

    const despues = await FileModel.findOne({ userId, content_id: CONTENT_ID }).lean();
    assert.ok(despues, 'el archivo debería seguir existiendo después del push');

    assert.deepEqual(
      despues!.platforms_discarded, ['instagram'],
      'El descarte explícito del usuario debe sobrevivir al push. Hoy no: la protección de ' +
      'BUG-2026-09-06-04 re-agrega toda plataforma `confirmed` y la saca de descartados, sin poder ' +
      'distinguir una acción explícita de un push automático atrasado.',
    );
    assert.deepEqual(
      despues!.platforms, [],
      'Instagram no debería volver a `platforms` después de un descarte explícito.',
    );
  } finally {
    // Base descartable: se limpia entera, no solo los documentos del test. Si
    // el drop falla se avisa por consola -- tragárselo en silencio dejaría
    // datos de prueba dando vueltas sin que nadie se entere.
    try {
      await mongoose.connection.dropDatabase();
    } catch (err: any) {
      console.warn(`[harness] no se pudo limpiar ${TEST_URI}: ${err?.message ?? err}`);
    }
    await mongoose.disconnect().catch(() => { /* ya cerrada */ });
  }
});
