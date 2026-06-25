import { createContext, useContext, useState, useEffect, ReactNode, createElement } from "react";

export type UserRole = "todopoderoso" | "editor" | "visitante";
export type UserTier = "free" | "premium";

interface AuthUser {
  username: string;
  role: UserRole;
  tier: UserTier;
  isOwner?: boolean;
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

import { API_BASE } from "../config";
const STORAGE_KEY = "esse_auth_token";

function decodeJwtUser(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    if (!payload.username || !payload.role) return null;
    return {
      username: payload.username,
      role: payload.role as UserRole,
      tier: (payload.tier as UserTier) ?? "free",
      isOwner: !!payload.isOwner,
    };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? decodeJwtUser(saved) : null;
  });
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [loading, setLoading] = useState(false);

  // Revalidación: lee de DB para tener el tier siempre actualizado
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;

    fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${saved}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        setToken(saved);
        setUser(data.user);
      })
      .catch(() => {
        localStorage.removeItem(STORAGE_KEY);
        setToken(null);
        setUser(null);
      });
  }, []);

  const login = async (username: string, password: string) => {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || "Credenciales incorrectas.");
    }
    const data = await res.json();
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem(STORAGE_KEY, data.token);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  return createElement(AuthContext.Provider, { value: { user, token, login, logout, loading } }, children);
}

export function useAuth() {
  return useContext(AuthContext);
}
