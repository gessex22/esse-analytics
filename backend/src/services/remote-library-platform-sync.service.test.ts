import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRemoteResolutionDelta } from './remote-library-platform-sync.service';

test('propaga a Nube un descarte nuevo recibido desde Biblioteca LAN', () => {
  const result = mergeRemoteResolutionDelta({}, [], ['youtube']);
  assert.deepEqual(result.platforms, []);
  assert.deepEqual(result.platformsDiscarded, ['youtube']);
  assert.deepEqual(result.platformStates, [{ platform: 'youtube', state: 'discarded' }]);
});

test('mueve un badge publicado a descartado y mantiene otras plataformas', () => {
  const result = mergeRemoteResolutionDelta(
    {
      platforms: ['youtube', 'tiktok'],
      platformsDiscarded: ['instagram'],
      platformStates: [
        { platform: 'youtube', state: 'badge_only' },
        { platform: 'tiktok', state: 'badge_only' },
        { platform: 'instagram', state: 'discarded' },
      ],
    },
    [],
    ['youtube'],
  );
  assert.deepEqual(result.platforms, ['tiktok']);
  assert.deepEqual(result.platformsDiscarded, ['instagram', 'youtube']);
  assert.deepEqual(result.platformStates.find(s => s.platform === 'youtube'), {
    platform: 'youtube', state: 'discarded',
  });
});

test('un descarte sin link no degrada una publicación confirmada', () => {
  const result = mergeRemoteResolutionDelta(
    {
      platforms: ['youtube'],
      platformStates: [{ platform: 'youtube', state: 'confirmed' }],
    },
    [],
    ['youtube'],
  );
  assert.deepEqual(result.platforms, ['youtube']);
  assert.deepEqual(result.platformsDiscarded, []);
  assert.deepEqual(result.platformStates, [{ platform: 'youtube', state: 'confirmed' }]);
});

test('publicar quita el descarte anterior', () => {
  const result = mergeRemoteResolutionDelta(
    {
      platformsDiscarded: ['youtube'],
      platformStates: [{ platform: 'youtube', state: 'discarded' }],
    },
    ['youtube'],
    [],
  );
  assert.deepEqual(result.platforms, ['youtube']);
  assert.deepEqual(result.platformsDiscarded, []);
  assert.deepEqual(result.platformStates, [{ platform: 'youtube', state: 'badge_only' }]);
});
