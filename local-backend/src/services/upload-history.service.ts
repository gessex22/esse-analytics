import { configRepo } from '../db/config.repo';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// Reporta a la central UN evento de subida confirmada, en el momento exacto en que
// pasa -- para que Historial (local y remoto/Android) tenga el registro real sin
// depender del push completo del catálogo (que puede tardar, fallar, o quedar
// flaco tras un wipe de logout). Best-effort: un fallo acá no debe romper una
// subida que ya se completó.
export function reportUploadEvent(
  authHeader: string | undefined,
  data: {
    platform: string;
    platformId: string;
    platformUrl?: string | null;
    fileName?: string | null;
    contentId?: string | null;
    title?: string | null;
    publishedAt?: string | Date;
  },
): void {
  if (!authHeader) return;
  const deviceId = configRepo.get('install_id');
  if (!deviceId) return;

  fetch(`${CENTRAL}/api/sync/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({
      deviceId,
      platform:    data.platform,
      platformId:  data.platformId,
      platformUrl: data.platformUrl ?? null,
      fileName:    data.fileName ?? null,
      contentId:   data.contentId ?? null,
      title:       data.title ?? null,
      publishedAt: data.publishedAt ? new Date(data.publishedAt).toISOString() : new Date().toISOString(),
    }),
  }).catch(() => { /* no-op */ });
}
