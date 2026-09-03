import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { decodeSignedAuthToken, signAuthToken } from '../services/auth-token.service';
import { decodeAuthToken } from '../middleware/auth.middleware';
import { UserModel } from '../models/user.model';
import { decodeState, encodeState, safeOrigin } from '../utils/oauth-state';
import { timingSafeStringEqual } from '../utils/secure-compare';

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
