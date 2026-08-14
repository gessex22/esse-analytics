import { deviceIdentityRepo } from '../db/device-identity.repo';
import { CENTRAL_API } from '../config';

const CENTRAL = CENTRAL_API;

export interface InstallationRole {
  role: 'primary' | 'secondary';
  canFullSync: boolean;
  canManageFolder: boolean;
  canUseAdHocUpload: boolean;
}

// Único punto que le pregunta a la central "¿esta PC es la primaria de la
// cuenta?" -- reusado por el proxy /api/local/installation-status (para que
// el frontend lo consulte) y por requirePrimaryDevice más abajo (para
// gatear escaneo/carpeta server-side, no solo en la UI). Ver
// docs/primary-install-corrected-plan-2026-08-14.md, Fase E.
//
// null = no se pudo consultar (central caída, sin red). Los callers deciden
// qué hacer con eso -- requirePrimaryDevice, por ejemplo, deja pasar en vez
// de bloquear a alguien por un problema de conectividad ajeno a si es o no
// la primaria (ver comentario ahí).
export async function fetchInstallationRole(authHeader: string): Promise<InstallationRole | null> {
  try {
    const deviceId = deviceIdentityRepo.getOrCreate();
    const res = await fetch(`${CENTRAL}/api/auth/installation-status?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: { Authorization: authHeader },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
