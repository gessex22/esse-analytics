import { getOrCreateDeviceName } from '../routes/local-admin.routes';
import { deviceIdentityRepo } from '../db/device-identity.repo';
import { CENTRAL_API } from '../config';

const CENTRAL = CENTRAL_API;

// Reporta a la central UN evento de subida confirmada, en el momento exacto en que
// pasa -- para que Historial (local y remoto/Android) tenga el registro real sin
// depender del push completo del catálogo (que puede tardar, fallar, o quedar
// flaco tras un wipe de logout). Best-effort: un fallo acá no debe romper una
// subida que ya se completó.
export async function reportUploadEvent(
  authHeader: string | undefined,
  data: {
    platform: string;
    source?: string;
    platformId: string;
    platformUrl?: string | null;
    fileName?: string | null;
    contentId?: string | null;
    title?: string | null;
    publishedAt?: string | Date;
  },
): Promise<void> {
  if (!authHeader) return;
  // FIX 2026-08-14: usaba configRepo.get('install_id') -- el secreto de auth
  // que se borra en cada logout, no la identidad estable de la PC (ver
  // docs/primary-install-corrected-plan-2026-08-14.md). Un video publicado
  // justo después de un logout/login quedaba con el device de Historial
  // desalineado, y si install_id todavía no se había regenerado (null), el
  // evento ni se reportaba (el `if (!deviceId) return` de abajo). deviceId
  // vía deviceIdentityRepo siempre existe (getOrCreate lo crea si falta).
  const deviceId = deviceIdentityRepo.getOrCreate();

  try {
    const res = await fetch(`${CENTRAL}/api/sync/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({
        deviceId,
        deviceName:  getOrCreateDeviceName(),
        source:      data.source ?? 'pc',
        platform:    data.platform,
        platformId:  data.platformId,
        platformUrl: data.platformUrl ?? null,
        fileName:    data.fileName ?? null,
        contentId:   data.contentId ?? null,
        title:       data.title ?? null,
        publishedAt: data.publishedAt ? new Date(data.publishedAt).toISOString() : new Date().toISOString(),
      }),
    });
    if (!res.ok) console.warn(`[history] central respondió HTTP ${res.status}`);
  } catch (err: any) {
    // La plataforma ya pudo haber publicado. No convertir una falla de
    // propagación en un falso error de subida; el push/tick podrá reintentar.
    console.warn('[history] no se pudo propagar el evento:', err.message);
  }
}

export async function reportUnlinkPlatform(
  authHeader: string | undefined,
  fileId: string,
  platform: string,
): Promise<void> {
  if (!authHeader) return;
  try {
    const res = await fetch(`${CENTRAL}/api/sync/platform-link/${encodeURIComponent(fileId)}/${encodeURIComponent(platform)}`, {
      method: 'DELETE',
      headers: { Authorization: authHeader },
    });
    if (!res.ok) console.warn(`[sync] no se pudo desvincular ${platform}: HTTP ${res.status}`);
  } catch (err: any) {
    console.warn('[sync] no se pudo propagar la desvinculación:', err.message);
  }
}
