// Lógica de sesión extraída de useAuth.tsx para que sea testeable sin React
// ni un DOM real. Resuelve el P0 de carrera de sesión: una respuesta tardía
// de bootstrap (revalidación /auth/me o restauración /api/local/session)
// iniciada bajo una credencial vieja nunca debe pisar un login/logout más
// nuevo. La defensa es un "epoch" monotónico: cada login/logout lo avanza
// apenas arrancan (no cuando terminan), y cada operación de bootstrap
// recuerda el epoch vigente al iniciar; si cambió antes de que la promesa
// resuelva, la respuesta se descarta en vez de aplicarse.

export type UserRole = "todopoderoso" | "editor" | "visitante";
export type UserTier = "free" | "premium";

export interface AuthUser {
  username: string;
  role: UserRole;
  tier: UserTier;
  isOwner?: boolean;
  theme?: string;
  // Plan de storage en la nube, aparte de tier==='premium' -- ver
  // requireCloudStorage en la central. Habilita la Biblioteca remota.
  hasCloudStorage?: boolean;
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
}

export interface AuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthSessionDeps {
  apiBase: string;
  storageKey: string;
  fetchImpl: typeof fetch;
  storage: AuthStorage;
  decodeJwtUser: (token: string) => AuthUser | null;
  applyUserTheme?: (theme?: string) => void;
}

// Único par de estados con los que la central confirma que la credencial ya no
// vale. Cualquier otra cosa (red caída, 5xx, 404 de una ruta mal escrita) es
// ambigua y por sí sola NO es motivo para cerrar la sesión de un token aún
// vigente (un token vencido/indecodificable se limpia aparte, sin red).
function isUnauthorizedStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function decodeJwtUser(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    if (!payload.username || !payload.role) return null;
    return {
      username: payload.username,
      role: payload.role as UserRole,
      tier: (payload.tier as UserTier) ?? "free",
      isOwner: !!payload.isOwner,
      hasCloudStorage: !!payload.hasCloudStorage,
    };
  } catch {
    return null;
  }
}

export class AuthSessionController {
  private deps: AuthSessionDeps;
  private state: AuthState;
  private listeners = new Set<() => void>();
  private epoch = 0;
  // Revalidaciones de 401 en vuelo, por token: varios 401 simultáneos de la
  // misma credencial comparten una sola llamada a /auth/me.
  private unauthorizedChecks = new Map<string, Promise<void>>();

  constructor(deps: AuthSessionDeps) {
    this.deps = deps;
    const saved = deps.storage.getItem(deps.storageKey);
    this.state = {
      user: saved ? deps.decodeJwtUser(saved) : null,
      token: saved,
      loading: false,
    };
  }

  getState = (): AuthState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(patch: Partial<AuthState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private bumpEpoch(): number {
    this.epoch += 1;
    return this.epoch;
  }

  private isCurrentEpoch(generation: number): boolean {
    return generation === this.epoch;
  }

  // Cierre de sesión por credencial inservible: confirmada inválida por la
  // central (/auth/me 401/403) o localmente comprobable (JWT vencido o
  // indecodificable). Doble defensa antes de tocar nada: el epoch debe seguir
  // siendo el de quien pidió la limpieza (no hubo login/logout más nuevo) y el
  // storage debe contener exactamente ese token (no se guardó otro mientras
  // tanto). Al limpiar avanza el epoch, igual que logout(), para invalidar
  // todo lo que quedó en vuelo.
  private clearSessionIfStillExactly(token: string, generation: number): void {
    if (!this.isCurrentEpoch(generation)) return;
    if (this.deps.storage.getItem(this.deps.storageKey) !== token) return;
    this.bumpEpoch();
    this.deps.storage.removeItem(this.deps.storageKey);
    this.setState({ token: null, user: null });
  }

  // Un JWT vencido o indecodificable no sirve con o sin red: no hace falta (ni
  // conviene esperar a) la central para saberlo. Es la única causa de limpieza
  // que no depende de un 401/403; red caída o 5xx por sí solos nunca limpian
  // un token todavía válido.
  private isTokenLocallyUnusable(token: string): boolean {
    return this.deps.decodeJwtUser(token) === null;
  }

  // Cuando la central no confirmó nada (red caída, 5xx) conservamos la sesión,
  // salvo que el propio token sea localmente inservible.
  private clearIfTokenUnusable(token: string, generation: number): void {
    if (!this.isTokenLocallyUnusable(token)) return;
    this.clearSessionIfStillExactly(token, generation);
  }

  // Revalidación de montaje: restaura sesión local si no hay token, o
  // refresca contra /auth/me si lo hay. Se llama una sola vez por
  // AuthProvider (nunca en paralelo consigo misma), pero sí puede solaparse
  // con login()/logout() disparados por el usuario mientras está en vuelo.
  bootstrap = async (): Promise<void> => {
    const generation = this.epoch;
    const saved = this.deps.storage.getItem(this.deps.storageKey);

    if (!saved) {
      // Sin token guardado en este navegador: si estamos hablando con un
      // local-backend que ya tiene dueño vinculado (misma instalación,
      // típico de otro dispositivo en la misma LAN), reusamos esa sesión en
      // vez de exigir un login manual contra la central.
      try {
        const res = await this.deps.fetchImpl(`${this.deps.apiBase}/api/local/session`);
        if (!res.ok) return;
        const data = await res.json();
        const decoded = this.deps.decodeJwtUser(data.token);
        if (!decoded) return;
        if (!this.isCurrentEpoch(generation)) return; // login/logout más nuevo ya definió el estado vigente
        this.deps.storage.setItem(this.deps.storageKey, data.token);
        this.setState({ token: data.token, user: decoded });
      } catch {
        // sin sesión local disponible: no hacer nada
      }
      return;
    }

    let res: Response;
    try {
      res = await this.deps.fetchImpl(`${this.deps.apiBase}/api/auth/me`, {
        headers: { Authorization: `Bearer ${saved}` },
      });
    } catch {
      // Red caída / central o túnel abajo: la central no confirmó nada.
      // Arrancar Electron sin internet no debe desloguear a un token aún
      // válido; uno vencido/indecodificable sí se limpia (no necesita red).
      this.clearIfTokenUnusable(saved, generation);
      return;
    }

    if (!res.ok) {
      // Del lado de la central, solo un 401/403 confirma que la credencial dejó
      // de valer; un 5xx es un problema de la central, no de la sesión (y
      // entonces solo limpia un token localmente inservible).
      if (isUnauthorizedStatus(res.status)) this.clearSessionIfStillExactly(saved, generation);
      else this.clearIfTokenUnusable(saved, generation);
      return;
    }

    let data: { user?: AuthUser & { theme?: string } };
    try {
      data = await res.json();
    } catch {
      return; // 200 con cuerpo ilegible: ambiguo, conservamos la sesión
    }
    if (!this.isCurrentEpoch(generation)) return; // login/logout más nuevo ya definió el estado vigente
    this.setState({ token: saved, user: data.user ?? null });
    this.deps.applyUserTheme?.(data.user?.theme);
  };

  // Un 401 llegó desde cualquier petición de la app (ver services/api.ts →
  // sessionSignal). Conservador a propósito: ese 401 puede venir del OAuth de
  // YouTube/Instagram/TikTok y no de la sesión central, así que nunca cerramos
  // sesión por el 401 en sí. La sesión se cierra solo si (a) el JWT es
  // localmente inservible (vencido/indecodificable: sin red) o (b) /auth/me
  // confirma con 401/403 que la credencial ya no vale. Con un token aún
  // vigente, red caída, 5xx o un 200 conservan la sesión.
  handleUnauthorized = (token: string): Promise<void> => {
    if (!token) return Promise.resolve();
    // 401 de una credencial que ya no es la vigente (login/logout posterior):
    // se descarta sin tocar la red.
    if (this.deps.storage.getItem(this.deps.storageKey) !== token) return Promise.resolve();

    const generation = this.epoch;

    // Token ya comprobablemente muerto: invalidar sin red. Si la segunda
    // revalidación fallara (túnel caído), el usuario quedaría atrapado con una
    // credencial que no sirve.
    if (this.isTokenLocallyUnusable(token)) {
      this.clearSessionIfStillExactly(token, generation);
      return Promise.resolve();
    }

    const inFlight = this.unauthorizedChecks.get(token);
    if (inFlight) return inFlight; // una sola revalidación por token

    const check = this.revalidateSession(token, generation).finally(() => {
      this.unauthorizedChecks.delete(token);
    });
    this.unauthorizedChecks.set(token, check);
    return check;
  };

  private async revalidateSession(token: string, generation: number): Promise<void> {
    let res: Response;
    try {
      res = await this.deps.fetchImpl(`${this.deps.apiBase}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      return; // red caída: ambiguo, conservamos la sesión
    }
    if (res.ok) return; // la sesión central sigue viva: el 401 era de otra cosa
    if (!isUnauthorizedStatus(res.status)) return; // 5xx u otro estado ambiguo: conservar
    this.clearSessionIfStillExactly(token, generation);
  }

  login = async (username: string, password: string): Promise<void> => {
    const generation = this.bumpEpoch(); // invalida cualquier bootstrap en vuelo desde este momento
    const res = await this.deps.fetchImpl(`${this.deps.apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Credenciales incorrectas.");
    }
    const data = await res.json();
    if (!this.isCurrentEpoch(generation)) return; // un login/logout posterior ya ganó la carrera
    this.deps.storage.setItem(this.deps.storageKey, data.token);
    this.setState({ token: data.token, user: data.user });
    this.deps.applyUserTheme?.(data.user?.theme);
  };

  logout = (): void => {
    this.bumpEpoch(); // invalida cualquier bootstrap/login en vuelo desde este momento
    this.deps.storage.removeItem(this.deps.storageKey);
    this.setState({ token: null, user: null });
  };
}
