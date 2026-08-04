import { DbFile, fileRepo } from '../db/file.repo';
import { configRepo } from '../db/config.repo';
import { ensureNextVideoInRemoteLibrary } from './remote-library-preload.service';
import { appendDebugLog } from './video-normalize.service';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

type CentralCalendarEntry = {
  platform: 'youtube' | 'instagram' | 'tiktok';
  lastPublishedTitle?: string | null;
  lastPublishedDate?: string | null;
  intervalDays?: number | null;
  nextVideo?: { fileId: string; contentId?: string | null; title: string } | null;
};

/** La central manda el próximo; SQLite solo conserva un espejo local. */
export async function syncCalendarFromCentral(authHeader: string | undefined): Promise<void> {
  if (!authHeader) return;
  const res = await fetch(`${CENTRAL}/api/sync/calendar-config`, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    const detail = `[calendar] no se pudo leer la configuracion de la central (${res.status})`;
    appendDebugLog(detail);
    console.warn(detail);
    return;
  }

  const entries = await res.json() as CentralCalendarEntry[];
  for (const entry of entries) {
    if (!['youtube', 'instagram', 'tiktok'].includes(entry.platform)) continue;
    const nextFile = entry.nextVideo
      ? (entry.nextVideo.contentId ? fileRepo.findByContentId(entry.nextVideo.contentId) : undefined)
        ?? fileRepo.findByName(entry.nextVideo.title)
      : undefined;
    const lastFile = entry.lastPublishedTitle ? fileRepo.findByName(entry.lastPublishedTitle) : undefined;

    configRepo.setPlatformConfig(entry.platform, {
      ...(entry.lastPublishedTitle !== undefined ? { last_published_title: entry.lastPublishedTitle ?? '' } : {}),
      ...(entry.lastPublishedDate !== undefined ? { last_published_date: entry.lastPublishedDate ?? '' } : {}),
      ...(entry.intervalDays != null ? { interval_days: entry.intervalDays } : {}),
      ...(entry.nextVideo ? { next_video_id: nextFile ? String(nextFile.id) : null } : { next_video_id: null }),
      ...(lastFile ? { last_video_id: String(lastFile.id) } : {}),
    });
  }
}

// El Calendario (PublishingQueue) lee su config del calendario CENTRAL (Mongo),
// no de configRepo.markPublished (que solo escribe el mirror local en SQLite).
// Sin este sync, "próxima publicación" nunca avanzaba para quien sube desde la
// vista de Subir en vez del botón "Fijar" del Calendario: nextVideoId se quedaba
// vacío en la central y la tarjeta caía siempre al video más nuevo (índice 0).
// Best-effort — un fallo acá no debe romper una subida que ya se completó.
//
// Además de avisar cuál es "el próximo", se encarga de que ese video
// específico tenga bytes reales en Biblioteca remota (almacenamiento
// dinámico -- ver remote-library-retention.service.ts en la central): el
// cliente es quien decide y precarga, la central solo administra lo que ya
// recibió. `nextFile` es el archivo local completo (no solo el título) para
// poder subirlo si hace falta.
export async function syncNextVideoToCentral(
  authHeader: string | undefined,
  platform: 'youtube' | 'instagram' | 'tiktok',
  data: { lastPublishedDate?: string; lastPublishedTitle?: string; nextFile: DbFile | undefined },
): Promise<void> {
  if (!authHeader) return;
  try {
    const nextRemoteLibraryVideoId = await ensureNextVideoInRemoteLibrary(authHeader, data.nextFile);
    const body = {
      ...(data.lastPublishedDate !== undefined ? { lastPublishedDate: data.lastPublishedDate } : {}),
      ...(data.lastPublishedTitle !== undefined ? { lastPublishedTitle: data.lastPublishedTitle } : {}),
      nextVideoId: data.nextFile?.file_name ?? null,
      ...(nextRemoteLibraryVideoId !== null ? { nextRemoteLibraryVideoId } : {}),
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${CENTRAL}/api/sync/calendar-config/${platform}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify(body),
        });
      } catch (err: any) {
        if (attempt === 3) throw err;
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        continue;
      }

      if (response.ok) return;
      const transient = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!transient || attempt === 3) {
        throw new Error(`la central respondió ${response.status}`);
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  } catch (err: any) {
    const detail = err instanceof Error ? err.message : String(err);
    const title = data.nextFile?.file_name ?? 'sin próximo video';
    appendDebugLog(`[calendar] no se pudo sincronizar ${platform} con la central tras 3 intentos (próximo: ${title}): ${detail}`);
    console.warn(`[calendar] no se pudo sincronizar ${platform} con la central: ${detail}`);
  }
}

// El precargado de syncNextVideoToCentral solo dispara en el instante exacto de
// publicar desde "Subir" de ESTA plataforma -- si el "próximo" avanzó por otro
// camino (celular, toggle en Videos, autocorrección de getCalendarConfig cuando
// el puntero guardado queda obsoleto) nadie vuelve a intentarlo, y Biblioteca
// remota se queda sin el archivo justo cuando el celular lo necesita. Pensada
// para correr periódica (ver syncOrchestrator.ts en el frontend), no solo tras
// publicar: por cada plataforma, si el "próximo" actual de la central todavía
// no tiene nextRemoteLibraryVideoId Y el archivo existe en ESTA PC, lo sube y
// fija el puntero (nextVideoId también, para no depender de que el cálculo
// dinámico de la central elija lo mismo la próxima vez que se lea).
export async function ensurePreloadForNextVideos(authHeader: string | undefined): Promise<void> {
  if (!authHeader) return;
  try {
    // Actualiza primero el espejo local: la central decide el próximo video.
    await syncCalendarFromCentral(authHeader);
    const res = await fetch(`${CENTRAL}/api/sync/calendar-config`, { headers: { Authorization: authHeader } });
    if (!res.ok) throw new Error(`la central respondio ${res.status} al consultar los proximos videos`);
    const configs: {
      platform: string;
      nextVideo?: { fileId: string; contentId?: string | null; title: string } | null;
      nextRemoteLibraryVideoId?: string | null;
    }[] = await res.json();

    for (const cfg of configs) {
      // No confiar en nextRemoteLibraryVideoId como prueba de que los bytes
      // siguen existiendo: puede ser un ID huérfano después de una liberación
      // por retención, una migración o un cambio de próximo video. La consulta
      // por contentId dentro de ensureNextVideoInRemoteLibrary es la fuente de
      // verdad y es barata cuando el video ya está precargado.
      if (!cfg.nextVideo) continue;
      if (!['youtube', 'instagram', 'tiktok'].includes(cfg.platform)) continue;

      const file = (cfg.nextVideo.contentId ? fileRepo.findByContentId(cfg.nextVideo.contentId) : undefined)
        ?? fileRepo.findByName(cfg.nextVideo.title);
      if (!file) continue; // el "próximo" lo tiene otro dispositivo, no esta PC

      const nextRemoteLibraryVideoId = await ensureNextVideoInRemoteLibrary(authHeader, file);
      if (!nextRemoteLibraryVideoId) continue;

      const response = await fetch(`${CENTRAL}/api/sync/calendar-config/${cfg.platform}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: JSON.stringify({ nextVideoId: cfg.nextVideo.fileId, nextRemoteLibraryVideoId }),
      });
      if (!response.ok) throw new Error(`la central respondió ${response.status} al precargar ${cfg.platform}`);
    }
  } catch (err: any) {
    const detail = err instanceof Error ? err.message : String(err);
    appendDebugLog(`[calendar] precarga de próximos videos falló: ${detail}`);
    console.warn(`[calendar] precarga de próximos videos falló: ${detail}`);
  }
}
