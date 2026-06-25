// Helpers para llevar el "origin" del frontend a través del flujo OAuth.
// El state viaja a Google/Meta/TikTok y vuelve en el callback; ahí decidimos
// a qué frontend redirigir (local del cliente vs. la versión online).

const DEFAULT_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173';

interface StatePayload {
  u: string;   // userId
  o?: string;  // origin del frontend
}

// Codifica userId + origin en un state opaco (base64url de JSON).
export function encodeState(userId: string, origin?: string): string {
  const payload: StatePayload = { u: userId };
  if (origin) payload.o = origin;
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

// Decodifica el state. Soporta el formato viejo (solo userId en base64url).
export function decodeState(state: string): { userId: string; origin: string } {
  try {
    const raw = Buffer.from(state, 'base64url').toString();
    const parsed = JSON.parse(raw) as StatePayload;
    if (parsed && typeof parsed.u === 'string') {
      return { userId: parsed.u, origin: safeOrigin(parsed.o) };
    }
  } catch {
    // No es JSON → formato legacy (el state ERA el userId crudo)
  }
  const legacyUserId = Buffer.from(state, 'base64url').toString();
  return { userId: legacyUserId, origin: DEFAULT_ORIGIN };
}

// Valida que el origin sea uno permitido (anti open-redirect).
// Permite: localhost, 127.0.0.1, redes locales (192.168.x, 10.x, 172.16-31.x)
// y el dominio de producción.
export function safeOrigin(origin?: string): string {
  if (!origin) return DEFAULT_ORIGIN;
  try {
    const u = new URL(origin);
    const h = u.hostname;
    const ok =
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h.startsWith('192.168.') ||
      h.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h === 'esse-analytics.com' ||
      h.endsWith('.esse-analytics.com');
    return ok ? origin.replace(/\/$/, '') : DEFAULT_ORIGIN;
  } catch {
    return DEFAULT_ORIGIN;
  }
}
