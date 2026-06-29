// ── Modo móvil ────────────────────────────────────────────────────────────────
// "Modo móvil" = el dueño (y, en el futuro, usuarios premium) entrando desde el
// celular hacia su propio backend local a través del túnel de Acceso Remoto
// (app.esse-analytics.com → :4000) o por LAN. En ese contexto `isLocal` es true,
// así que el flujo de publicación normal funciona; lo único que cambia es que en
// pantalla de teléfono restringimos la publicación a quien tenga permiso.

import type { UserRole, UserTier } from "../hooks/useAuth";

// Cuando se habilite el rollout a premium, poner en true: los usuarios premium
// podrán publicar desde el celular además del dueño. Hoy: solo el dueño.
export const MOBILE_PUBLISH_PREMIUM = false;

interface MobileGateUser {
  role?: UserRole;
  tier?: UserTier;
  isOwner?: boolean;
}

// ¿Puede esta cuenta publicar desde el celular (modo móvil)?
// Owner siempre; premium solo cuando se active el flag de rollout.
export function canPublishOnMobile(user: MobileGateUser | null | undefined): boolean {
  if (!user) return false;
  if (user.isOwner) return true;
  if (MOBILE_PUBLISH_PREMIUM && user.tier === "premium") return true;
  return false;
}
