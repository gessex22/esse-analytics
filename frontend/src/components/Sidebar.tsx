import { motion } from "motion/react";
import {
  Settings, BarChart2, Film, Users, Upload, TrendingUp, Wrench,
  CalendarDays, Gem, History, Cloud,
} from "lucide-react";
import logoImg from "../assets/esseAnalytics.png";

export const navItems = [
  { icon: BarChart2,    label: "Dashboard"     },
  { icon: Film,         label: "Videos"        },
  { icon: Upload,       label: "Subir"         },
  { icon: Users,        label: "Usuarios"      },
  { icon: TrendingUp,   label: "Estadísticas"  },
  { icon: Wrench,       label: "Taller"        },
  { icon: Settings,     label: "Ajustes"       },
  { icon: CalendarDays, label: "Calendario"    },
  { icon: Gem,          label: "Gemas"         },
  { icon: History,      label: "Historial"    },
  // Biblioteca remota (Premium + storage en la nube) -- a diferencia del resto,
  // NO es local-only: vive tanto en el cliente de Electron como en acceso remoto
  // (ver LOCAL_ONLY_NAV / isNavVisible en App.tsx, que la deja afuera de ese set).
  { icon: Cloud,         label: "Nube"          },
];

// Actividad (auditoría) ya no es un ítem propio de nav -- vive dentro de
// Ajustes (ver ALL_SECTIONS en SettingsView.tsx) para no ocupar un slot del
// sidebar por una vista de "consultar de vez en cuando", y de paso queda
// alcanzable en mobile (Ajustes ya está en MOBILE_NAV, Actividad sola no lo estaba).
export const ACTIVE_VIEWS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
export const MOBILE_NAV   = [1, 2, 7, 5, 6, 10];

// Orden de visualización del sidebar (por importancia). Son índices de `navItems`;
// la navegación sigue siendo por índice, así que esto NO cambia la lógica, solo el
// orden en pantalla. Pipeline de contenido arriba; administración (Usuarios, Ajustes) al fondo.
// Estadísticas (4) va justo debajo de Dashboard (0). Historial (9) junto a Calendario (7),
// ambos sobre el registro de publicaciones. Nube (10) al lado de Videos (1), mismo concepto
// de biblioteca.
export const NAV_ORDER = [0, 4, 1, 10, 2, 7, 9, 5, 8, 3, 6];

interface SidebarProps {
  effectiveNav: number;
  isNavVisible: (i: number) => boolean;
  onNavClick: (i: number) => void;
}

export function Sidebar({ effectiveNav, isNavVisible, onNavClick }: SidebarProps) {
  return (
    <aside className="hidden sm:flex relative w-52 flex-shrink-0 flex-col bg-background">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-4">
        <img src={logoImg} alt="EsseAnalytics" className="w-9 h-9 flex-shrink-0 rounded-lg" />
        <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.02em", fontSize: "0.95rem" }}>
          <span className="text-foreground">Esse</span><span className="text-primary">Analytics</span>
        </span>
      </div>

      {/* Nav — centrado absoluto respecto a todo el alto del sidebar, sin importar el logo */}
      <nav className="absolute left-0 right-0 top-1/2 -translate-y-1/2 max-h-full flex flex-col justify-center px-3 py-4 overflow-y-auto">
        {NAV_ORDER.map((i) => {
          const { icon: Icon, label } = navItems[i];
          if (!isNavVisible(i)) return null;
          const isActive = effectiveNav === i;

          return (
            <button
              key={label}
              onClick={() => onNavClick(i)}
              className={`relative isolate w-full flex items-center gap-3 px-3 py-2.5 rounded-full mb-0.5 text-sm transition-colors ${
                isActive
                  ? "text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              {isActive && (
                <motion.span
                  layoutId="sidebar-nav-indicator"
                  className="absolute inset-0 -z-10 rounded-full bg-secondary"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <Icon className={`relative z-10 w-4 h-4 flex-shrink-0 ${isActive ? "text-primary" : ""}`} />
              <span className="relative z-10 flex-1 text-left">{label}</span>
              {!ACTIVE_VIEWS.has(i) && (
                <span className="relative z-10 text-[9px] border border-border rounded px-1 text-muted-foreground/50 leading-tight">
                  PRONTO
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

interface MobileNavProps {
  effectiveNav: number;
  isNavVisible: (i: number) => boolean;
  onNavClick: (i: number) => void;
}

export function MobileNav({ effectiveNav, isNavVisible, onNavClick }: MobileNavProps) {
  return (
    <nav
      className="sm:hidden fixed bottom-0 left-0 right-0 z-40 flex items-center border-t border-border bg-card"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0px)" }}
    >
      {MOBILE_NAV.filter(isNavVisible).map((i) => {
        const { icon: Icon, label } = navItems[i];
        const isActive = effectiveNav === i;
        return (
          <button
            key={i}
            onClick={() => onNavClick(i)}
            className="relative flex-1 flex flex-col items-center justify-center py-2.5 gap-1 transition-colors"
          >
            {/* Indicador superior activo */}
            {isActive && (
              <motion.span
                layoutId="mobile-nav-indicator"
                className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-primary"
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
              />
            )}
            <Icon className={`w-5 h-5 transition-colors ${isActive ? "text-primary" : "text-muted-foreground"}`} />
            <span className={`text-[10px] leading-none font-medium transition-colors ${isActive ? "text-primary" : "text-muted-foreground"}`}>
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
