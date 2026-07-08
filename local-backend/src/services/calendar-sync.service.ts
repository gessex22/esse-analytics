const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// El Calendario (PublishingQueue) lee su config del calendario CENTRAL (Mongo),
// no de configRepo.markPublished (que solo escribe el mirror local en SQLite).
// Sin este sync, "próxima publicación" nunca avanzaba para quien sube desde la
// vista de Subir en vez del botón "Fijar" del Calendario: nextVideoId se quedaba
// vacío en la central y la tarjeta caía siempre al video más nuevo (índice 0).
// Best-effort — un fallo acá no debe romper una subida que ya se completó.
export async function syncNextVideoToCentral(
  authHeader: string | undefined,
  platform: 'youtube' | 'instagram' | 'tiktok',
  data: { lastPublishedDate: string; lastPublishedTitle: string; nextVideoTitle: string | null },
): Promise<void> {
  if (!authHeader) return;
  try {
    await fetch(`${CENTRAL}/api/sync/calendar-config/${platform}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({
        lastPublishedDate:  data.lastPublishedDate,
        lastPublishedTitle: data.lastPublishedTitle,
        nextVideoId:        data.nextVideoTitle ?? undefined,
      }),
    });
  } catch { /* no-op */ }
}
