import {
  IPlatformState,
  upsertBadgeOnly,
  upsertDiscarded,
} from '../utils/platform-state.util';

export type RemoteSyncPlatform = 'youtube' | 'instagram' | 'tiktok';

type RemoteResolutionState = {
  platforms?: RemoteSyncPlatform[];
  platformsDiscarded?: RemoteSyncPlatform[];
  platformStates?: IPlatformState<RemoteSyncPlatform>[];
};

type MergedRemoteResolutionState = {
  platforms: RemoteSyncPlatform[];
  platformsDiscarded: RemoteSyncPlatform[];
  platformStates: IPlatformState<RemoteSyncPlatform>[];
};

// Aplica únicamente las transiciones que el catálogo de la PC acaba de
// confirmar. Así un push completo no reemplaza a ciegas el estado propio de
// Biblioteca remota, pero los descartes hechos por LAN sí llegan a Nube.
export function mergeRemoteResolutionDelta(
  remote: RemoteResolutionState,
  addedPublished: RemoteSyncPlatform[],
  addedDiscarded: RemoteSyncPlatform[],
): MergedRemoteResolutionState {
  const platforms = new Set(remote.platforms ?? []);
  const discarded = new Set(remote.platformsDiscarded ?? []);
  let states = remote.platformStates ?? [];

  for (const platform of addedPublished) {
    platforms.add(platform);
    discarded.delete(platform);
    states = upsertBadgeOnly(states, platform);
  }

  for (const platform of addedDiscarded) {
    // Un descarte sin link real no puede degradar una publicación confirmada.
    if (states.find(s => s.platform === platform)?.state === 'confirmed') continue;
    platforms.delete(platform);
    discarded.add(platform);
    states = upsertDiscarded(states, platform);
  }

  return {
    platforms: Array.from(platforms),
    platformsDiscarded: Array.from(discarded),
    platformStates: states,
  };
}
