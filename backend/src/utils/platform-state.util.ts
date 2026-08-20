// Estado explícito de publicación por plataforma — introducido para
// BUG-2026-08-15-03 (docs/bug-reports.md): antes `platforms`/`platforms_discarded`
// solo decían SI/NO por plataforma, sin distinguir una publicación real
// (con `platformId`, permite link+métricas) de una marca histórica manual
// (badge sin ningún link detrás -- video publicado antes de usar EsseAnalytics
// o por un canal externo). Los clientes interpretaban esa ambigüedad distinto
// entre sí, causando que el mismo video apareciera resuelto en una plataforma
// y disponible en otra.
//
// Este archivo es el único lugar que define el tipo y las reglas de
// transición -- todo el resto (FileModel, RemoteLibraryVideoModel,
// backup.controller.ts, remote-library.controller.ts) lo importa de acá para
// no duplicar el criterio.
export type PlatformPublicationState = 'confirmed' | 'badge_only' | 'discarded';

export interface IPlatformState<P extends string = string> {
  platform: P;
  state: PlatformPublicationState;
}

// Mongoose sub-schema fields (declarados acá para no repetir el shape en los
// 2 modelos -- se usan con `type: [platformStateSchemaFields]` en cada uno).
export const platformStateSchemaFields = {
  platform: { type: String, required: true },
  state: { type: String, enum: ['confirmed', 'badge_only', 'discarded'], required: true },
};

// Regla dura en las 3 funciones de abajo: 'confirmed' (viene de un
// `platformId` real, ver applyPlatformPublish) nunca se degrada a
// 'badge_only' ni se pisa por un 'discarded' que llegue de un caller que solo
// mandó el array final de badges/descartes sin saber que ya había un link
// real detrás (ej. un toggle viejo de UI que re-manda el estado completo).
// Si el usuario quiere descartar algo ya confirmado de verdad, es una acción
// explícita que debe pasar por el mismo `platformId`/link, no por este path.

export function upsertConfirmed<P extends string>(states: IPlatformState<P>[], platform: P): IPlatformState<P>[] {
  return [...states.filter(s => s.platform !== platform), { platform, state: 'confirmed' as const }];
}

export function upsertBadgeOnly<P extends string>(states: IPlatformState<P>[], platform: P): IPlatformState<P>[] {
  if (states.find(s => s.platform === platform)?.state === 'confirmed') return states;
  return [...states.filter(s => s.platform !== platform), { platform, state: 'badge_only' as const }];
}

export function upsertDiscarded<P extends string>(states: IPlatformState<P>[], platform: P): IPlatformState<P>[] {
  if (states.find(s => s.platform === platform)?.state === 'confirmed') return states;
  return [...states.filter(s => s.platform !== platform), { platform, state: 'discarded' as const }];
}

// Recalcula platform_states a partir de los 2 arrays finales que ya manda el
// caller (mismo shape que `platforms`/`platformsDiscarded` de siempre) --
// usado por los endpoints "toggle completo" (updateFilePlatforms,
// updateRemoteLibraryVideoPlatforms) que no mandan un link real, solo el
// resultado final del badge/descarte por plataforma.
export function deriveStatesFromToggle<P extends string>(
  existingStates: IPlatformState<P>[],
  platforms: P[],
  platformsDiscarded: P[],
): IPlatformState<P>[] {
  let states = existingStates;
  for (const p of platforms) states = upsertBadgeOnly(states, p);
  for (const p of platformsDiscarded) states = upsertDiscarded(states, p);
  // Lo que salió de los dos arrays (volvió a "pendiente") no debe seguir
  // arrastrando un estado viejo.
  const stillTracked = new Set<P>([...platforms, ...platformsDiscarded]);
  return states.filter(s => stillTracked.has(s.platform));
}
