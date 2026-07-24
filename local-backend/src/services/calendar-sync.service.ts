import { DbFile, fileRepo } from '../db/file.repo';
import { ensureNextVideoInRemoteLibrary } from './remote-library-preload.service';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

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
  data: { lastPublishedDate: string; lastPublishedTitle: string; nextFile: DbFile | undefined },
): Promise<void> {
  if (!authHeader) return;
  try {
    const nextRemoteLibraryVideoId = await ensureNextVideoInRemoteLibrary(authHeader, data.nextFile);
    await fetch(`${CENTRAL}/api/sync/calendar-config/${platform}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({
        lastPublishedDate:  data.lastPublishedDate,
        lastPublishedTitle: data.lastPublishedTitle,
        nextVideoId:        data.nextFile?.file_name ?? undefined,
        nextRemoteLibraryVideoId: nextRemoteLibraryVideoId ?? undefined,
      }),
    });
  } catch { /* no-op */ }
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
    const res = await fetch(`${CENTRAL}/api/sync/calendar-config`, { headers: { Authorization: authHeader } });
    if (!res.ok) return;
    const configs: {
      platform: string;
      nextVideo?: { fileId: string; title: string } | null;
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

      const file = fileRepo.findByName(cfg.nextVideo.title);
      if (!file) continue; // el "próximo" lo tiene otro dispositivo, no esta PC

      const nextRemoteLibraryVideoId = await ensureNextVideoInRemoteLibrary(authHeader, file);
      if (!nextRemoteLibraryVideoId) continue;

      await fetch(`${CENTRAL}/api/sync/calendar-config/${cfg.platform}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: JSON.stringify({ nextVideoId: cfg.nextVideo.fileId, nextRemoteLibraryVideoId }),
      }).catch(() => {});
    }
  } catch { /* best-effort, igual que syncNextVideoToCentral */ }
}
