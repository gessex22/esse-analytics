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

    try {
      const res = await this.deps.fetchImpl(`${this.deps.apiBase}/api/auth/me`, {
        headers: { Authorization: `Bearer ${saved}` },
      });
      if (!res.ok) throw new Error("auth/me failed");
      const data = await res.json();
      if (!this.isCurrentEpoch(generation)) return; // login/logout más nuevo ya definió el estado vigente
      this.setState({ token: saved, user: data.user });
      this.deps.applyUserTheme?.(data.user?.theme);
    } catch {
      if (!this.isCurrentEpoch(generation)) return; // login/logout más nuevo ya definió el estado vigente
      // Solo borramos la credencial si sigue siendo exactamente la que esta
      // petición validó -- si mientras tanto se guardó una nueva (por un
      // login concurrente que ya pasó su propio epoch check), no la tocamos.
      if (this.deps.storage.getItem(this.deps.storageKey) !== saved) return;
      this.deps.storage.removeItem(this.deps.storageKey);
      this.setState({ token: null, user: null });
    }
  };

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
