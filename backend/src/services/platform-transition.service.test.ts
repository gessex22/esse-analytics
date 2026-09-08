import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyExplicitTransition, ResolutionState } from './platform-transition.service';

const estado = (
  platforms: string[],
  platformsDiscarded: string[],
  states: ResolutionState['states'],
): ResolutionState => ({ platforms, platformsDiscarded, states });

test('unlink deja la plataforma AUSENTE de platform_states, no en un estado nuevo', () => {
  const r = applyExplicitTransition(
    estado(['instagram', 'tiktok'], [], [
      { platform: 'instagram', state: 'confirmed' },
      { platform: 'tiktok', state: 'badge_only' },
    ]),
    'instagram',
    'unlink',
  );
  assert.deepEqual(r.platforms, ['tiktok']);
  assert.deepEqual(r.platformsDiscarded, []);
  // "pending" es la ausencia -- decisión cerrada del plan, no se agrega un 4º
  // valor al enum.
  assert.equal(r.states.find(s => s.platform === 'instagram'), undefined);
  assert.deepEqual(r.states, [{ platform: 'tiktok', state: 'badge_only' }]);
});

test('discard quita el badge y marca discarded', () => {
  const r = applyExplicitTransition(
    estado(['instagram'], [], [{ platform: 'instagram', state: 'badge_only' }]),
    'instagram',
    'discard',
  );
  assert.deepEqual(r.platforms, []);
  assert.deepEqual(r.platformsDiscarded, ['instagram']);
  assert.deepEqual(r.states, [{ platform: 'instagram', state: 'discarded' }]);
});

// El corazón del bug 2: hoy `upsertDiscarded` se niega a degradar un
// `confirmed`, y esa negativa -- correcta para un toggle que re-manda el
// estado completo -- deja al usuario sin ninguna forma de soltar una
// plataforma confirmada desde el escritorio.
test('una acción explícita SÍ puede degradar un confirmed (es la diferencia con un push automático)', () => {
  const confirmado = estado(['instagram'], [], [{ platform: 'instagram', state: 'confirmed' }]);

  const descartado = applyExplicitTransition(confirmado, 'instagram', 'discard');
  assert.deepEqual(descartado.platforms, []);
  assert.deepEqual(descartado.platformsDiscarded, ['instagram']);
  assert.deepEqual(descartado.states, [{ platform: 'instagram', state: 'discarded' }]);

  const desvinculado = applyExplicitTransition(confirmado, 'instagram', 'unlink');
  assert.deepEqual(desvinculado.platforms, []);
  assert.deepEqual(desvinculado.states, []);
});

test('no toca las otras plataformas', () => {
  const r = applyExplicitTransition(
    estado(['youtube', 'instagram'], ['tiktok'], [
      { platform: 'youtube', state: 'confirmed' },
      { platform: 'instagram', state: 'confirmed' },
      { platform: 'tiktok', state: 'discarded' },
    ]),
    'instagram',
    'unlink',
  );
  assert.deepEqual(r.platforms, ['youtube']);
  assert.deepEqual(r.platformsDiscarded, ['tiktok']);
  assert.deepEqual(
    r.states.sort((a, b) => a.platform.localeCompare(b.platform)),
    [{ platform: 'tiktok', state: 'discarded' }, { platform: 'youtube', state: 'confirmed' }],
  );
});

test('es idempotente: repetir la misma transición no cambia el resultado', () => {
  const inicial = estado(['instagram'], [], [{ platform: 'instagram', state: 'confirmed' }]);

  const unaVez = applyExplicitTransition(inicial, 'instagram', 'discard');
  const dosVeces = applyExplicitTransition(unaVez, 'instagram', 'discard');
  assert.deepEqual(dosVeces, unaVez);

  const unlinkUna = applyExplicitTransition(inicial, 'instagram', 'unlink');
  const unlinkDos = applyExplicitTransition(unlinkUna, 'instagram', 'unlink');
  assert.deepEqual(unlinkDos, unlinkUna);
});

test('descartar y después desvincular deja la plataforma sin rastro', () => {
  const inicial = estado(['instagram'], [], [{ platform: 'instagram', state: 'confirmed' }]);
  const r = applyExplicitTransition(
    applyExplicitTransition(inicial, 'instagram', 'discard'),
    'instagram',
    'unlink',
  );
  assert.deepEqual(r.platforms, []);
  assert.deepEqual(r.platformsDiscarded, []);
  assert.deepEqual(r.states, []);
});

test('una plataforma que no estaba no aparece de la nada al desvincular', () => {
  const r = applyExplicitTransition(estado([], [], []), 'tiktok', 'unlink');
  assert.deepEqual(r, { platforms: [], platformsDiscarded: [], states: [] });
});
