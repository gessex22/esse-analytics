import { DbFile } from '../db/file.repo';
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
