import './_setup-env'; // debe ir primero -- ver ese archivo.
import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { decodeSignedAuthToken, signAuthToken } from '../services/auth-token.service';
import { decodeAuthToken } from '../middleware/auth.middleware';
import { UserModel } from '../models/user.model';
import { decodeState, encodeState, safeOrigin } from '../utils/oauth-state';
import { timingSafeStringEqual } from '../utils/secure-compare';
import { sanitizeErrorsIf } from '../middleware/request.middleware';

// Doble mínimo de Response -- statusCode mutable + res.json/res.send reales
// (no mocks) para poder verificar que sanitizeErrorsIf de verdad reemplaza lo
// que se manda, no solo que lo intenta.
function responseDouble() {
  const state = { statusCode: 200, sent: undefined as unknown, locals: { requestId: 'req-test-1' } };
  const response: any = {
    statusCode: 200,
    locals: state.locals,
    json(body: unknown) { state.sent = body; return response; },
    send(body: unknown) { state.sent = body; return response; },
  };
  Object.defineProperty(response, 'statusCode', {
    get: () => state.statusCode,
    set: (v: number) => { state.statusCode = v; },
  });
  return { response, state };
}

const claims = {
  id: '507f1f77bcf86cd799439011',
  username: 'test-user',
  role: 'todopoderoso' as const,
  tier: 'premium' as const,
  hasCloudStorage: true,
  authVersion: 3,
};

test('JWT acepta solo tokens HS256 íntegros', () => {
  const token = signAuthToken(claims, '5m');
  const decoded = decodeSignedAuthToken(token);
  assert.equal(decoded?.id, claims.id);
  assert.equal(decoded?.authVersion, 3);

  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(decodeSignedAuthToken(tampered), null);
});

test('JWT expirado se rechaza', () => {
  const token = signAuthToken(claims, -1);
  assert.equal(decodeSignedAuthToken(token), null);
});

test('autorización revalida estado, rol y versión contra MongoDB', async (t) => {
  const token = signAuthToken(claims, '5m');
  t.mock.method(UserModel, 'findById', () => ({
    select: () => ({
      lean: async () => ({
        _id: claims.id,
        username: claims.username,
        role: 'visitante',
        tier: 'free',
        status: 'active',
        hasCloudStorage: false,
        authVersion: 3,
      }),
    }),
  }) as any);

  const current = await decodeAuthToken(token);
  assert.equal(current?.role, 'visitante');
  assert.equal(current?.tier, 'free');
});

test('autorización revoca cuenta eliminada o versión antigua', async (t) => {
  const token = signAuthToken(claims, '5m');
  let status = 'deleted';
  let authVersion = 3;
  t.mock.method(UserModel, 'findById', () => ({
    select: () => ({
      lean: async () => ({ ...claims, _id: claims.id, status, authVersion }),
    }),
  }) as any);

  assert.equal(await decodeAuthToken(token), null);
  status = 'active';
  authVersion = 4;
  assert.equal(await decodeAuthToken(token), null);
});

test('comparación de secretos exige igualdad exacta', () => {
  assert.equal(timingSafeStringEqual('correct-secret', 'correct-secret'), true);
  assert.equal(timingSafeStringEqual('correct-secreu', 'correct-secret'), false);
  assert.equal(timingSafeStringEqual(undefined, 'correct-secret'), false);
});

test('OAuth solo conserva orígenes autorizados', () => {
  assert.equal(safeOrigin('http://localhost:5173/path?ignored=1'), 'http://localhost:5173');
  assert.equal(safeOrigin('http://192.168.1.25:4000/path'), 'http://192.168.1.25:4000');
  assert.equal(safeOrigin('https://attacker.example'), 'http://localhost:5173');
});

test('OAuth state está firmado, expira y su nonce se consume una sola vez', async () => {
  const nonces = new Map<string, any>();
  const collection = {
    createIndex: async () => 'ok',
    insertOne: async (doc: any) => { nonces.set(doc.nonceHash, doc); return { acknowledged: true }; },
    findOneAndDelete: async (filter: any) => {
      const doc = nonces.get(filter.nonceHash);
      if (!doc || doc.userId !== filter.userId || doc.expiresAt <= filter.expiresAt.$gt) return null;
      nonces.delete(filter.nonceHash);
      return doc;
    },
  };
  const previousDb = mongoose.connection.db;
  (mongoose.connection as any).db = { collection: () => collection };

  try {
    const state = await encodeState(claims.id, 'http://localhost:5173', 'android');
    const decoded = await decodeState(state);
    assert.equal(decoded.userId, claims.id);
    assert.equal(decoded.client, 'android');
    await assert.rejects(() => decodeState(state), /utilizado|desconocido/);

    const tampered = `${state.slice(0, -1)}${state.endsWith('a') ? 'b' : 'a'}`;
    await assert.rejects(() => decodeState(tampered), /inválido/);
  } finally {
    (mongoose.connection as any).db = previousDb;
  }
});

// Cobertura nueva del hallazgo "sanitizeProductionErrors sin ningún test" --
// usa sanitizeErrorsIf(true) directo en vez de depender de NODE_ENV=production
// real (env.IS_PRODUCTION queda congelado al importar env.ts una sola vez).
test('saneo de errores 500 reemplaza el cuerpo solo en producción y solo si statusCode>=500', () => {
  const middleware = sanitizeErrorsIf(true);
  const { response, state } = responseDouble();
  middleware({} as any, response, () => {});
  response.statusCode = 500;
  response.json({ message: 'boom', error: 'ruta física secreta' });
  assert.deepEqual(state.sent, { message: 'Error interno.', requestId: 'req-test-1' });
});

test('saneo de errores 500 también cubre res.send, no solo res.json', () => {
  const middleware = sanitizeErrorsIf(true);
  const { response, state } = responseDouble();
  middleware({} as any, response, () => {});
  response.statusCode = 500;
  response.send('stack trace filtrado a mano por un controlador legacy');
  assert.deepEqual(JSON.parse(state.sent as string), { message: 'Error interno.', requestId: 'req-test-1' });
});

test('saneo de errores no toca respuestas 2xx/4xx', () => {
  const middleware = sanitizeErrorsIf(true);
  const { response, state } = responseDouble();
  middleware({} as any, response, () => {});
  response.statusCode = 404;
  response.json({ message: 'Usuario no encontrado.' });
  assert.deepEqual(state.sent, { message: 'Usuario no encontrado.' });
});

test('saneo de errores es no-op fuera de producción', () => {
  const middleware = sanitizeErrorsIf(false);
  const { response, state } = responseDouble();
  let nextCalled = false;
  middleware({} as any, response, () => { nextCalled = true; });
  response.statusCode = 500;
  response.json({ message: 'boom', error: 'detalle interno' });
  assert.equal(nextCalled, true);
  assert.deepEqual(state.sent, { message: 'boom', error: 'detalle interno' });
});
