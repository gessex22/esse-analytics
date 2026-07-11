import { AnimatePresence, motion } from "motion/react";
import {
  Settings, BarChart2, Film, Users, Upload, TrendingUp, Wrench, Palette,
  ShieldCheck, Tv2, ChevronDown, CalendarDays, FolderOpen, Gem, Database, Cloud,
} from "lucide-react";
import logoImg from "../assets/esseAnalytics.png";

// Sub-secciones de Ajustes
export const SETTINGS_SECTIONS = [
  { id: "colores",    label: "Colores",         icon: Palette,       roles: ["todopoderoso", "editor"], localOnly: false },
  { id: "biblioteca", label: "Biblioteca",       icon: FolderOpen,    roles: ["todopoderoso"],           localOnly: false },
  { id: "seguridad",  label: "Seguridad",        icon: ShieldCheck,   roles: ["todopoderoso"],           localOnly: false },
  { id: "sync",       label: "Sincronización",   icon: Tv2,           roles: ["todopoderoso"],           localOnly: false },
  { id: "frieden",    label: "Remoto y Backup",  icon: Cloud,         roles: ["todopoderoso"],           localOnly: true  },
  { id: "datos",      label: "Datos locales",    icon: Database,      roles: ["todopoderoso"],           localOnly: true  },
];

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
];

export const ACTIVE_VIEWS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
export const MOBILE_NAV   = [1, 2, 7, 5, 6];

// Orden de visualización del sidebar (por importancia). Son índices de `navItems`;
// la navegación sigue siendo por índice, así que esto NO cambia la lógica, solo el
// orden en pantalla. Pipeline de contenido arriba; administración (Usuarios, Ajustes) al fondo.
// Estadísticas (4) va justo debajo de Dashboard (0).
export const NAV_ORDER = [0, 4, 1, 2, 7, 5, 8, 3, 6];

interface SidebarProps {
  effectiveNav: number;
  settingsOpen: boolean;
  activeSection: string;
  isNavVisible: (i: number) => boolean;
  visibleSettingsSections: typeof SETTINGS_SECTIONS;
  onNavClick: (i: number) => void;
  onSectionClick: (id: string) => void;
}

export function Sidebar({
  effectiveNav, settingsOpen, activeSection, isNavVisible,
  visibleSettingsSections, onNavClick, onSectionClick,
}: SidebarProps) {
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
          const isSettings = i === 6;
          const isActive   = effectiveNav === i;

          return (
            <div key={label}>
              <button
                onClick={() => onNavClick(i)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-full mb-0.5 text-sm transition-colors ${
                  isActive
                    ? "bg-secondary text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                }`}
              >
                <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? "text-primary" : ""}`} />
                <span className="flex-1 text-left">{label}</span>
                {!ACTIVE_VIEWS.has(i) && (
                  <span className="text-[9px] border border-border rounded px-1 text-muted-foreground/50 leading-tight">
                    PRONTO
                  </span>
                )}
                {isSettings && (
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${settingsOpen ? "rotate-180" : ""}`} />
                )}
              </button>

              {/* Sub-items de Ajustes */}
              <AnimatePresence initial={false}>
                {isSettings && settingsOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <div className="ml-3 mb-1 pl-3 space-y-0.5 pt-0.5">
                      {visibleSettingsSections.map(({ id, label: subLabel, icon: SubIcon }, subIdx) => {
                        const isSubActive = effectiveNav === 6 && activeSection === id;
                        return (
                          <motion.button
                            key={id}
                            initial={{ opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: subIdx * 0.05, duration: 0.18 }}
                            onClick={() => onSectionClick(id)}
                            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-full text-xs transition-colors ${
                              isSubActive
                                ? "bg-secondary text-foreground font-medium"
                                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                            }`}
                          >
                            <SubIcon className={`w-3.5 h-3.5 flex-shrink-0 ${isSubActive ? "text-primary" : ""}`} />
                            {subLabel}
                          </motion.button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
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
