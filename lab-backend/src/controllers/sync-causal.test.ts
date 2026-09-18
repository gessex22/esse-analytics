import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import * as store from '../store/db';
import * as sync from './sync.controller';

const USER = { id: 'usuario-lab', username: 'lab', role: 'editor', tier: 'free', isOwner: false, hasCloudStorage: false };

function call(handler: (req: any, res: any) => void, body: any) {
  const captured: { status: number; body: any } = { status: 200, body: undefined };
  const res: any = {
    status(code: number) { captured.status = code; return res; },
    json(value: any) { captured.body = value; return res; },
  };
  handler({ user: USER, body, params: {}, query: {}, headers: {} } as any, res);
  return captured;
}

function identity(fileName: string, clientFileId: string) {
  return call(sync.resolveIdentity, { fileName, deviceId: 'android-lab', clientFileId });
}

beforeEach(() => store.resetDb());

test('LAB SYNC — la identidad es idempotente por dispositivo/archivo y nunca por nombre', () => {
  const a1 = identity('mismo.mp4', 'archivo-a');
  const a2 = identity('mismo.mp4', 'archivo-a');
  const b = identity('mismo.mp4', 'archivo-b');

  assert.equal(a1.status, 200);
  assert.equal(a1.body.contentId, a2.body.contentId);
  assert.notEqual(a1.body.contentId, b.body.contentId);
  assert.deepEqual(a1.body.platformRev, { youtube: 0, instagram: 0, tiktok: 0 });
});

test('LAB SYNC — la transición aplica CAS y deduplica por operationId', () => {
  const contentId = identity('transicion.mp4', 'archivo-t').body.contentId;
  const body = { contentId, platform: 'instagram', action: 'discard', operationId: 'op-t', baseVersion: 0 };
  const first = call(sync.applyPlatformTransition, body);
  const retry = call(sync.applyPlatformTransition, body);
  const stale = call(sync.applyPlatformTransition, { ...body, operationId: 'op-vieja' });

  assert.deepEqual([first.status, first.body.version, first.body.platformsDiscarded], [200, 1, ['instagram']]);
  assert.deepEqual([retry.status, retry.body.deduplicated, retry.body.version], [200, true, 1]);
  assert.deepEqual([stale.status, stale.body.reason, stale.body.version], [409, 'stale', 1]);
});

test('LAB SYNC — el vínculo manual mueve B a A y su reintento no lo aplica dos veces', () => {
  const b = identity('origen.mp4', 'archivo-b').body.contentId;
  const a = identity('destino.mp4', 'archivo-a').body.contentId;
  call(sync.recordUploadEvent, {
    platform: 'instagram', platformId: 'lab_ig_manual', platformUrl: 'https://laboratorio/link',
    fileName: 'origen.mp4', operationId: 'publish-b',
  });

  const body = {
    contentId: a, platform: 'instagram', platformId: 'lab_ig_manual',
    platformUrl: 'https://laboratorio/link', operationId: 'move-b-a',
  };
  const first = call(sync.manualPlatformLink, body);
  const retry = call(sync.manualPlatformLink, body);
  const db = store.getDb();
  const origen = db.files.find(f => f.contentId === b)!;
  const destino = db.files.find(f => f.contentId === a)!;
  const link = db.platformVideos.find(v => v.platformId === 'lab_ig_manual')!;

  assert.deepEqual([origen.platforms, destino.platforms, link.linkedFileId], [[], ['instagram'], destino.id]);
  assert.deepEqual([first.body.version, retry.body.version, retry.body.deduplicated], [1, 1, true]);
});

test('LAB SYNC — los contratos causales rechazan claves incompletas', () => {
  assert.equal(call(sync.applyPlatformTransition, {}).status, 400);
  assert.equal(call(sync.manualPlatformLink, { contentId: 'x', platform: 'instagram', platformId: 'p' }).status, 400);
  assert.equal(call(sync.resolveIdentity, { fileName: 'x.mp4' }).status, 400);
  assert.equal(call(sync.resolveIdentity, {
    fileName: 'x.mp4', deviceId: 'android-lab', clientFileId: 'archivo-x', contentId: 'no-es-uuid',
  }).status, 400);
});
