import './_setup-env'; // debe ir primero -- ver ese archivo.
import assert from 'node:assert/strict';
import test from 'node:test';
import { requireCloudStorage, requirePremium, requireRole } from '../middleware/auth.middleware';
import { deleteFileFromDisk } from '../controllers/video.controller';
import { FileModel } from '../models/file.model';

function responseDouble() {
  const state = { status: 200, body: undefined as unknown };
  const response: any = {
    status(code: number) { state.status = code; return response; },
    json(body: unknown) { state.body = body; return response; },
  };
  return { response, state };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: '507f1f77bcf86cd799439011',
    username: 'client',
    role: 'visitante',
    tier: 'free',
    hasCloudStorage: false,
    authVersion: 0,
    ...overrides,
  };
}

test('requireRole usa el rol revalidado de la solicitud', () => {
  const { response, state } = responseDouble();
  let continued = false;
  requireRole('todopoderoso')({ user: user() } as any, response, () => { continued = true; });
  assert.equal(continued, false);
  assert.equal(state.status, 403);
});

test('gates de plan exigen premium y entitlement de almacenamiento', () => {
  const premiumOnly = responseDouble();
  let premiumContinued = false;
  requirePremium(
    { user: user({ tier: 'premium' }) } as any,
    premiumOnly.response,
    () => { premiumContinued = true; },
  );
  assert.equal(premiumContinued, true);

  const cloud = responseDouble();
  let cloudContinued = false;
  requireCloudStorage(
    { user: user({ tier: 'premium', hasCloudStorage: false }) } as any,
    cloud.response,
    () => { cloudContinued = true; },
  );
  assert.equal(cloudContinued, false);
  assert.equal(cloud.state.status, 403);
});

test('ruta destructiva scopea la búsqueda por el usuario autenticado', async (t) => {
  let observedFilter: unknown;
  t.mock.method(FileModel, 'findOne', (filter: unknown) => {
    observedFilter = filter;
    return Promise.resolve(null) as any;
  });

  const { response, state } = responseDouble();
  const req = {
    params: { fileId: '507f191e810c19729de860ea' },
    user: user({ id: 'owner-a' }),
  } as any;
  await deleteFileFromDisk(req, response);

  assert.deepEqual(observedFilter, {
    _id: '507f191e810c19729de860ea',
    userId: 'owner-a',
  });
  assert.equal(state.status, 404);
});
