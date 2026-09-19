// Señal interna de "sesión no autorizada": el transporte HTTP
// (`services/api.ts`) avisa cuando una petición devolvió 401 usando una
// credencial concreta, y quien maneja la sesión (AuthProvider →
// AuthSessionController) decide qué hacer.
//
// Es un pub/sub mínimo a propósito:
// - No usa `window` ni eventos del DOM, así se puede probar sin navegador y
//   nadie de afuera de la app puede escuchar ni disparar la señal.
// - El único dato que viaja es el token exacto que usó ESA petición, para que
//   el controlador pueda descartar sin red los 401 de credenciales viejas.
//   Ese token es una credencial: nunca se loguea ni se expone en errores.
// - El transporte no conoce al AuthProvider y el AuthProvider no conoce al
//   transporte; este módulo es el único punto de contacto.

export type UnauthorizedListener = (token: string) => void;

const listeners = new Set<UnauthorizedListener>();

/** Suscribe un handler de 401. Devuelve la función para desuscribirse. */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publica un 401 observado por el transporte. `token` es la credencial exacta
 * que llevaba esa petición; sin credencial no hay sesión que revalidar.
 */
export function notifyUnauthorized(token: string | null | undefined): void {
  if (!token) return;
  // Copia: un listener puede desuscribirse mientras iteramos.
  for (const listener of [...listeners]) {
    try {
      listener(token);
    } catch {
      // Un suscriptor roto no debe romper la petición HTTP que disparó la señal.
      // No logueamos el error porque el contexto incluye la credencial.
    }
  }
}
