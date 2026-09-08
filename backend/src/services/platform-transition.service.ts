// Escritor único de estado de plataforma — Entrega 1.2 de
// docs/sync-convergence-plan-2026-09-08.md.
//
// PROBLEMA QUE RESUELVE. El mismo hecho ("¿este video está publicado en esta
// plataforma, con qué link?") vive en ~11 representaciones. Hoy lo escriben 6
// callers distintos, cada uno cubriendo un subconjunto distinto de esas
// representaciones, con su propia regla escrita a mano. Los bugs viven en los
// pares que nadie reconcilia: un `unlink` que solo tocaba `FileModel` dejaba
// el espejo de `backup_platform_videos` apuntando al archivo viejo, y el
// siguiente pull lo resucitaba (BUG-2026-09-07-01).
//
// LA DISTINCIÓN QUE FALTABA. Una ACCIÓN EXPLÍCITA del usuario sí puede
// degradar un `confirmed`; un push automático atrasado no. Hoy la protección
// de `confirmed` (BUG-2026-09-06-04) no puede distinguirlas, y por eso un
// descarte hecho en Electron se revierte solo en el siguiente tick. Todo lo
// que entra por acá es, por definición, una acción explícita.
//
// CLAVE DE MUTACIÓN: `content_id`, nunca un id local ni `file_name`. Ver la
// sección "Evidencia" del plan -- 100% de los archivos activos de los dos
// lados ya lo tienen, con índice único `{userId, content_id}`.

import { FileModel } from '../models/file.model';
import { BackupFileModel } from '../models/backup-file.model';
import { PlatformVideoModel, SyncPlatform } from '../models/platform-video.model';
import { BackupPlatformVideoModel } from '../models/backup-platform-video.model';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { IPlatformState } from '../utils/platform-state.util';

/** Las 3 plataformas con estado propio comparable. 'facebook' es crosspost. */
export const TRANSITION_PLATFORMS = ['youtube', 'instagram', 'tiktok'] as const;
export type TransitionPlatform = (typeof TRANSITION_PLATFORMS)[number];

export type PlatformTransitionAction = 'unlink' | 'discard';

export interface PlatformTransitionResult {
  ok: boolean;
  /** 'not_found' = no hay archivo con ese content_id para este usuario. */
  reason?: 'not_found';
  fileId?: string;
  platforms?: string[];
  platformsDiscarded?: string[];
}

// ---------------------------------------------------------------------------
// Núcleo puro — sin Mongo, testeable solo. Toda la semántica de la transición
// vive acá; la parte de abajo solo la aplica a cada representación.
// ---------------------------------------------------------------------------

export interface ResolutionState {
  platforms: string[];
  platformsDiscarded: string[];
  states: IPlatformState[];
}

/**
 * Aplica una acción EXPLÍCITA del usuario sobre una plataforma.
 *
 * - `unlink`:  queda sin badge, sin descarte y AUSENTE de `platform_states`.
 *              "Pending" no es un estado guardado, es la ausencia (decisión
 *              cerrada del plan: no se agrega un 4º valor al enum).
 * - `discard`: queda sin badge y marcada `discarded`.
 *
 * A diferencia de `upsertDiscarded` en platform-state.util.ts, acá un
 * `confirmed` SÍ se degrada: esa protección existe para que un toggle que
 * re-manda el estado completo no pise un link real, no para bloquear al
 * usuario cuando decide explícitamente soltar la plataforma.
 */
export function applyExplicitTransition(
  current: ResolutionState,
  platform: string,
  action: PlatformTransitionAction,
): ResolutionState {
  const platforms = current.platforms.filter(p => p !== platform);
  const platformsDiscarded = current.platformsDiscarded.filter(p => p !== platform);
  const states = current.states.filter(s => s.platform !== platform);

  if (action === 'discard') {
    platformsDiscarded.push(platform);
    states.push({ platform, state: 'discarded' });
  }

  return { platforms, platformsDiscarded, states };
}

// ---------------------------------------------------------------------------
// Orquestación — aplica la transición a TODAS las representaciones.
// ---------------------------------------------------------------------------

/**
 * Punto de entrada único para soltar o descartar una plataforma.
 *
 * Idempotente: repetir la misma llamada deja el mismo estado final (todas las
 * escrituras son "poner en este valor", no incrementos).
 *
 * `upload_history` y `audit_events` NO se tocan a propósito: son historial de
 * lo que pasó, no estado actual. Borrar de ahí falsearía la bitácora.
 */
export async function applyPlatformTransition(
  userId: string,
  // `platform` es SyncPlatform (incluye 'facebook'): el crosspost también se
  // puede desvincular, igual que hoy lo permite `unlinkPlatform`. Lo que
  // 'facebook' NO tiene es representación propia en Nube -- ver el guard de
  // TRANSITION_PLATFORMS más abajo.
  input: { contentId: string; platform: SyncPlatform; action: PlatformTransitionAction },
): Promise<PlatformTransitionResult> {
  const { contentId, platform, action } = input;

  // Resolución SOLO por content_id: si no está, se falla ruidosamente en vez
  // de caer a `file_name` (que ya causó daño real -- `final -` vs `FINAL -`
  // son dos documentos distintos, y `final  - sufre.mp4` con doble espacio
  // rompió el Calendario).
  const file = await FileModel.findOne({ userId, content_id: contentId });
  if (!file) return { ok: false, reason: 'not_found' };

  const ahora = new Date();

  // 1) files — la representación canónica.
  const next = applyExplicitTransition(
    {
      platforms: file.platforms ?? [],
      platformsDiscarded: file.platforms_discarded ?? [],
      states: (file.platform_states ?? []) as IPlatformState[],
    },
    platform,
    action,
  );

  await FileModel.updateOne(
    { _id: file._id },
    {
      $set: {
        platforms: next.platforms,
        platforms_discarded: next.platformsDiscarded,
        platform_states: next.states,
        // El reloj dedicado ya existe y el pull lo usa para desempatar. Moverlo
        // acá es lo que hace que una acción explícita le gane a un push viejo
        // que todavía no sabe de ella. No es un reloj nuevo (eso es Entrega 3),
        // es usar bien el que hay.
        platforms_updated_at: ahora,
      },
    },
  );

  // 2) backup_files — la otra copia del mismo catálogo, mientras exista
  //    (se retira en la Entrega 5). Sin esto, el próximo `getBackupFiles`
  //    puede servir el estado viejo desde la colección equivocada.
  await BackupFileModel.updateOne(
    { userId, content_id: contentId },
    {
      $set: {
        platforms: next.platforms,
        platforms_discarded: next.platformsDiscarded,
        platforms_updated_at: ahora,
      },
    },
  );

  // 3) platformvideos — se desvincula el link real, pero NO se borra el
  //    documento: conserva platformId/métricas/fecha por si el video se vuelve
  //    a emparejar. Mismo criterio que ya usaba `unlinkPlatform`.
  await PlatformVideoModel.updateMany(
    { userId, linkedFileId: file._id, platform },
    { $set: { linkedFileId: null, matchStatus: 'sin_match' } },
  );

  // 4) backup_platform_videos — el espejo desde el que el escritorio
  //    RECONSTRUYE sus links locales al hacer pull. Acá sí se borra la fila: un
  //    link que ya no existe no debe reconstruirse. Sin este paso el pull
  //    resucita el vínculo y el unlink se deshace solo (BUG-2026-09-07-01).
  await BackupPlatformVideoModel.deleteMany({ userId, platform, content_id: contentId });

  // 5) remote_library_videos — la copia de Nube. Solo si el video vive ahí y
  //    solo para las 3 plataformas que ese modelo conoce.
  if ((TRANSITION_PLATFORMS as readonly string[]).includes(platform)) {
    const remote = await RemoteLibraryVideoModel.findOne({ userId, contentId });
    if (remote) {
      const remoteNext = applyExplicitTransition(
        {
          platforms: (remote.platforms ?? []) as string[],
          platformsDiscarded: (remote.platformsDiscarded ?? []) as string[],
          states: (remote.platformStates ?? []) as IPlatformState[],
        },
        platform,
        action,
      );
      await RemoteLibraryVideoModel.updateOne(
        { _id: remote._id },
        {
          $set: {
            platforms: remoteNext.platforms,
            platformsDiscarded: remoteNext.platformsDiscarded,
            platformStates: remoteNext.states,
            // El link real también se va: es lo que distingue esta acción de
            // un simple cambio de badge.
            platformLinks: (remote.platformLinks ?? []).filter((l: any) => l.platform !== platform),
          },
        },
      );
    }
  }

  return {
    ok: true,
    fileId: String(file._id),
    platforms: next.platforms,
    platformsDiscarded: next.platformsDiscarded,
  };
}
