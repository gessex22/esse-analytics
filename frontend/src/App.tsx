import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell, Settings, BarChart2, Film, Users,
  Upload, Clock, TrendingUp, Wrench, Palette, ShieldCheck, Tv2, ChevronDown, LogOut,
  CalendarDays, FolderOpen, Gem,
} from "lucide-react";
import { Taller } from "./components/Taller";
import { PublishingQueue } from "./components/PublishingQueue";
import { VideosView } from "./components/VideosView";
import { SettingsView } from "./components/SettingsView";
import { LoginPage } from "./components/LoginPage";
import { LandingPage } from "./components/LandingPage";
import { YoutubeUploadView } from "./components/YoutubeUploadView";
import { useAuth } from "./hooks/useAuth";
import { RemoteGate } from "./components/RemoteGate";
import { useBackendType } from "./hooks/useBackendType";
import { GemsPanel } from "./components/GemsPanel";
import { UsersPanel } from "./components/UsersPanel";
import logoImg from "./assets/esseAnalytics.png";

// Sub-secciones de Ajustes
export const SETTINGS_SECTIONS = [
  { id: "colores",    label: "Colores",         icon: Palette,       roles: ["todopoderoso", "editor"] },
  { id: "biblioteca", label: "Biblioteca",       icon: FolderOpen,    roles: ["todopoderoso"] },
  { id: "seguridad",  label: "Seguridad",        icon: ShieldCheck,   roles: ["todopoderoso"] },
  { id: "sync",       label: "Sincronización",   icon: Tv2,           roles: ["todopoderoso"] },
];

const navItems = [
  { icon: BarChart2,    label: "Dashboard"   },
  { icon: Film,         label: "Videos"      },
  { icon: Upload,       label: "Subir"       },
  { icon: Users,        label: "Usuarios"    },
  { icon: TrendingUp,   label: "Analíticas"  },
  { icon: Wrench,       label: "Taller"      },
  { icon: Settings,     label: "Ajustes"     },
  { icon: CalendarDays, label: "Calendario"  },
  { icon: Gem,          label: "Gemas"       },
];

const ACTIVE_VIEWS = new Set([1, 2, 3, 5, 6, 7, 8]);
const MOBILE_NAV   = [1, 2, 7, 5, 6];

function ProximamenteView({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center h-full min-h-[300px]">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
          <Clock className="w-8 h-8 text-primary/50" />
        </div>
        <div>
          <h2 className="text-foreground text-xl font-semibold">{label}</h2>
          <p className="text-muted-foreground text-sm mt-1">Esta sección estará disponible próximamente</p>
        </div>
        <span className="inline-block bg-primary/10 text-primary text-xs px-3 py-1 rounded-full font-mono">
          PRÓXIMAMENTE
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const { user, logout, loading } = useAuth();
  const { isLocal } = useBackendType();
  const [showLogin, setShowLogin] = useState(false);
  const [activeNav, setActiveNav]           = useState(1);
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [activeSection, setActiveSection]   = useState("colores");
  const [pendingPlayer, setPendingPlayer]   = useState<{ fileId: string; title: string } | null>(null);

  function openVideoPlayer(fileId: string, title: string) {
    setPendingPlayer({ fileId, title });
    setActiveNav(1);
  }

  // Mientras verifica el token guardado
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <motion.span
          className="w-10 h-10 rounded-full border-2 border-primary/30 block"
          style={{ borderTopColor: "var(--primary)" }}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
        />
      </div>
    );
  }

  // Sin sesión → landing o login
  if (!user) {
    if (showLogin) return <LoginPage />;
    return <LandingPage onLogin={() => setShowLogin(true)} />;
  }

  // Editor: navegar solo a Videos, Taller y Calendario
  const role = user.role;
  const visibleSettingsSections = SETTINGS_SECTIONS.filter(s => {
    if (!s.roles.includes(role)) return false;
    // "Seguridad" es administración central: solo el dueño del servicio, nunca en local
    if (s.id === "seguridad") return !isLocal && !!user.isOwner;
    return true;
  });
  const allowedNavForEditor = new Set([1, 2, 5, 7]); // Videos, Subir, Taller y Calendario
  const visibleNavItems = navItems.filter((_, i) => {
    if (role === "todopoderoso") return true;
    return allowedNavForEditor.has(i);
  });

  // Asegurar que activeNav sea válido para el rol
  const effectiveNav = role === "editor" && !allowedNavForEditor.has(activeNav) ? 1 : activeNav;

  const handleNavClick = (i: number) => {
    if (i === 6) {
      // Ajustes: toggle el acordeón y navega a la vista
      setSettingsOpen((v) => !v);
      setActiveNav(6);
    } else {
      setSettingsOpen(false);
      setActiveNav(i);
    }
  };

  const handleSectionClick = (sectionId: string) => {
    setActiveSection(sectionId);
    setActiveNav(6);
  };

  const headerLabel = activeNav === 6
    ? `Ajustes › ${SETTINGS_SECTIONS.find(s => s.id === activeSection)?.label ?? ""}`
    : navItems[activeNav]?.label ?? "";

  return (
    <RemoteGate>
    <div className="flex bg-background text-foreground overflow-hidden" style={{ fontFamily: "'Inter', sans-serif", height: "100dvh" }}>

      {/* ── Sidebar (sm+) ─────────────────────────────────────────────────── */}
      <aside className="hidden sm:flex w-52 flex-shrink-0 border-r border-border flex-col bg-card">
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
          <img src={logoImg} alt="EsseAnalytics" className="w-9 h-9 flex-shrink-0 rounded-lg" />
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.02em", fontSize: "0.95rem" }}>
            <span className="text-foreground">Esse</span><span className="text-primary">Analytics</span>
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          {navItems.map(({ icon: Icon, label }, i) => {
            if (role === "editor" && !allowedNavForEditor.has(i)) return null;
            const isSettings = i === 6;
            const isActive   = effectiveNav === i;

            return (
              <div key={label}>
                <button
                  onClick={() => handleNavClick(i)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg mb-0.5 text-sm transition-colors ${
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
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
                      <div className="ml-3 mb-1 border-l border-border pl-3 space-y-0.5 pt-0.5">
                        {visibleSettingsSections.map(({ id, label: subLabel, icon: SubIcon }, subIdx) => {
                          const isSubActive = activeNav === 6 && activeSection === id;
                          return (
                            <motion.button
                              key={id}
                              initial={{ opacity: 0, x: -6 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: subIdx * 0.05, duration: 0.18 }}
                              onClick={() => handleSectionClick(id)}
                              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-colors ${
                                isSubActive
                                  ? "bg-primary/10 text-primary font-medium"
                                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                              }`}
                            >
                              <SubIcon className="w-3.5 h-3.5 flex-shrink-0" />
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

        {/* Usuario */}
        <div className="px-4 py-4 border-t border-border flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-semibold flex-shrink-0">
            {user.username[0].toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm truncate font-medium">{user.username}</p>
            <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
          </div>
          <button
            onClick={logout}
            title="Cerrar sesión"
            className="text-muted-foreground hover:text-foreground transition-colors p-1 flex-shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </aside>

      {/* ── Área principal ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Header */}
        <header className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-border bg-card flex-shrink-0">

          {/* Mobile: solo logo */}
          <div className="flex items-center gap-2 sm:hidden">
            <img src={logoImg} alt="EsseAnalytics" className="w-8 h-8 flex-shrink-0 rounded-md" />
            <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.02em", fontSize: "0.85rem" }}>
              <span className="text-foreground">Esse</span><span className="text-primary">Analytics</span>
            </span>
          </div>

          {/* Desktop: solo el título de sección */}
          <div className="hidden sm:block">
            <h1 className="text-foreground text-xl font-bold leading-tight">{headerLabel}</h1>
            <p className="text-muted-foreground text-sm">Gestiona y supervisa tu contenido</p>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {role === "todopoderoso" && (
              <>
                <button className="relative text-muted-foreground hover:text-foreground p-1">
                  <Bell className="w-5 h-5" />
                  <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-primary rounded-full" />
                </button>
                <button className="hidden sm:flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm hover:bg-primary/90 transition-colors">
                  <Upload className="w-4 h-4" />
                  Subir
                </button>
              </>
            )}
            {/* Logout móvil */}
            <button
              onClick={logout}
              className="sm:hidden text-muted-foreground hover:text-foreground p-1 transition-colors"
              title="Cerrar sesión"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Contenido */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0 sm:min-h-screen">
          {effectiveNav === 5
            ? <Taller role={role} isLocal={isLocal} />
            : (
              <main
                className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 sm:py-6 sm:pb-0"
                style={{ paddingBottom: "max(5rem, calc(env(safe-area-inset-bottom) + 5rem))" }}
              >
                {effectiveNav === 1 ? <VideosView role={role} autoOpenVideo={pendingPlayer} onAutoOpenConsumed={() => setPendingPlayer(null)} />
                  : effectiveNav === 2 ? <YoutubeUploadView />
                  : effectiveNav === 6 ? <SettingsView activeSection={activeSection} role={role} onSectionChange={setActiveSection} />
                  : effectiveNav === 7 ? <PublishingQueue role={role} onOpenVideo={openVideoPlayer} />
                  : effectiveNav === 3 ? (user.isOwner ? <UsersPanel /> : <ProximamenteView label="Usuarios" />)
                  : effectiveNav === 8 ? <GemsPanel isLocal={isLocal} userTier={user.isOwner ? "premium" : user.tier} />
                  : <ProximamenteView label={navItems[effectiveNav]?.label ?? ""} />
                }
              </main>
            )
          }
        </div>

        {/* ── Bottom nav móvil ────────────────────────────────────────────── */}
        <nav
          className="sm:hidden fixed bottom-0 left-0 right-0 z-40 flex items-center border-t border-border bg-card"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0px)" }}
        >
          {MOBILE_NAV.filter(i => role === "todopoderoso" || allowedNavForEditor.has(i)).map((i) => {
            const { icon: Icon, label } = navItems[i];
            const isActive = effectiveNav === i;
            return (
              <button
                key={i}
                onClick={() => handleNavClick(i)}
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
      </div>
    </div>
    </RemoteGate>
  );
}
