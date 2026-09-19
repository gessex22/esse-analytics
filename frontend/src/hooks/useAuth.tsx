import { createContext, useContext, useEffect, useRef, useSyncExternalStore, ReactNode, createElement } from "react";
import { applyTheme } from "./useTheme";
import { API_BASE } from "../config";
import { AuthSessionController, decodeJwtUser } from "./authSessionController";
import type { AuthUser } from "./authSessionController";
import { onUnauthorized } from "../services/sessionSignal";

export type { UserRole, UserTier, AuthUser } from "./authSessionController";

// Aplica el tema guardado en la cuenta (si es válido) y lo deja en localStorage.
function applyUserTheme(theme?: string) {
  if (theme === "rojo" || theme === "ambar") {
    applyTheme(theme);
    localStorage.setItem("videx-theme", theme);
  }
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  login: async () => {},
  logout: () => {},
  loading: false,
});

const STORAGE_KEY = "esse_auth_token";

export function AuthProvider({ children }: { children: ReactNode }) {
  // Una sola instancia por toda la vida del AuthProvider: el epoch de sesión
  // que arbitra las carreras entre bootstrap/login/logout vive acá.
  const controllerRef = useRef<AuthSessionController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new AuthSessionController({
      apiBase: API_BASE,
      storageKey: STORAGE_KEY,
      fetchImpl: (...args) => fetch(...args),
      storage: window.localStorage,
      decodeJwtUser,
      applyUserTheme,
    });
  }
  const controller = controllerRef.current;

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  // Revalidación de montaje: lee de DB para tener el tier siempre actualizado
  // (o restaura una sesión local si no hay token guardado en este navegador).
  useEffect(() => {
    controller.bootstrap();
  }, [controller]);

  // Sesión central vencida con la app abierta: cualquier petición que reciba
  // un 401 avisa acá con el token que usó, y el controlador decide (revalida
  // contra /auth/me; un 401 de OAuth de plataforma no cierra la sesión).
  useEffect(() => {
    return onUnauthorized((token) => {
      void controller.handleUnauthorized(token);
    });
  }, [controller]);

  const value: AuthContextValue = {
    user: state.user,
    token: state.token,
    loading: state.loading,
    login: controller.login,
    logout: controller.logout,
  };

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  return useContext(AuthContext);
}
