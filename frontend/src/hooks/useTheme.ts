import { useState, useEffect, createContext, useContext, ReactNode, createElement } from "react";
import { API_BASE } from "../config";

export type ThemeId = "rojo" | "ambar";

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  preview: { bg: string; primary: string; card: string };
}

export const THEMES: Theme[] = [
  {
    id: "rojo",
    name: "Rojo",
    description: "Fondo oscuro azulado con acento rojo",
    preview: { bg: "#0d0d0f", primary: "#e63946", card: "#141417" },
  },
  {
    id: "ambar",
    name: "Ámbar",
    description: "Fondo negro puro con acento ámbar dorado",
    preview: { bg: "#0a0a0a", primary: "#f59e0b", card: "#111111" },
  },
];

const STORAGE_KEY = "videx-theme";

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  THEMES.forEach((t) => root.classList.remove(`theme-${t.id}`));
  root.classList.add(`theme-${id}`);
}

// ── Context ────────────────────────────────────────────────────────────────────
interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "rojo",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    return (localStorage.getItem(STORAGE_KEY) as ThemeId) ?? "rojo";
  });

  const setTheme = (id: ThemeId) => {
    setThemeState(id);
    localStorage.setItem(STORAGE_KEY, id);
    applyTheme(id);
    // Persistir en la cuenta para tenerlo en cualquier dispositivo (best-effort).
    const token = localStorage.getItem("esse_auth_token");
    if (token) {
      fetch(`${API_BASE}/api/auth/me/theme`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ theme: id }),
      }).catch(() => {});
    }
  };

  // Aplica en el primer render
  useEffect(() => { applyTheme(theme); }, []);

  return createElement(ThemeContext.Provider, { value: { theme, setTheme } }, children);
}

export function useTheme() {
  return useContext(ThemeContext);
}
