import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell, Settings, BarChart2, Film, Users,
  Upload, Clock, TrendingUp, Wrench, Palette, ShieldCheck, Tv2, ChevronDown, LogOut,
  CalendarDays, FolderOpen, Gem, Database, AlertTriangle, Loader2, MonitorOff, X,
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
import { useIsMobile } from "./hooks/useIsMobile";
import { canPublishOnMobile } from "./lib/mobileMode";
import { useAutoBackup } from "./hooks/useAutoBackup";
import { GemsPanel } from "./components/GemsPanel";
import { UsersPanel } from "./components/UsersPanel";
import logoImg from "./assets/esseAnalytics.png";
import { backupService } from "./services/api";
import { API_BASE } from "./config";

// Vistas que requieren el dispositivo central (SQLite + archivos físicos).
// En remoto se ocultan: Videos, Subir, Taller, Gemas.
const LOCAL_ONLY_NAV = new Set([1, 2, 5, 8]);

// Sub-secciones de Ajustes
export const SETTINGS_SECTIONS = [
  { id: "colores",    label: "Colores",         icon: Palette,       roles: ["todopoderoso", "editor"], localOnly: false },
  { id: "biblioteca", label: "Biblioteca",       icon: FolderOpen,    roles: ["todopoderoso"],           localOnly: false },
  { id: "seguridad",  label: "Seguridad",        icon: ShieldCheck,   roles: ["todopoderoso"],           localOnly: false },
  { id: "sync",       label: "Sincronización",   icon: Tv2,           roles: ["todopoderoso"],           localOnly: false },
  { id: "datos",      label: "Datos locales",    icon: Database,      roles: ["todopoderoso"],           localOnly: true  },
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

// ── Diálogo de cierre de sesión ───────────────────────────────────────────────
type LogoutPhase = "idle" | "backing-up" | "wiping";

function LogoutDialog({
  isPremium, phase, onConfirm, onCancel,
}: { isPremium: boolean; phase: LogoutPhase; onConfirm: () => void; onCancel: () => void }) {
  const busy = phase !== "idle";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-amber-500/10 flex items-center justify-center flex-shrink-0">
            <LogOut className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h3 className="text-foreground font-semibold text-sm">Cerrar sesión</h3>
            <p className="text-muted-foreground text-xs mt-1 leading-snug">
              {isPremium
                ? "Se guardará una copia de tu catálogo en la nube antes de limpiar los datos locales."
                : "Al cerrar sesión se borrarán todos los datos locales de esta instalación (biblioteca, calendario, configuración). Esta acción no se puede deshacer."}
            </p>
          </div>
        </div>

        {busy && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20 text-primary text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
            {phase === "backing-up" ? "Guardando copia de seguridad en la nube…" : "Limpiando datos locales…"}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm border border-border bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white font-medium transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
            {isPremium ? "Guardar y salir" : "Sí, cerrar sesión"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

export default function App() {
  const { user, token, logout, loading } = useAuth();
  const { isLocal } = useBackendType();
  const isMobile = useIsMobile();
  const isPremium = !!user && (user.isOwner || user.tier === "premium");

  // Modo móvil: teléfono hablando con el backend local (vía túnel Acceso Remoto o LAN).
  // En ese contexto la publicación se restringe a quien tenga permiso (owner ahora,
  // premium cuando se active el flag en lib/mobileMode).
  const mobileMode      = isMobile && isLocal;
  const mobileCanUpload = canPublishOnMobile(user);

  // Backup automático: solo en el dispositivo central y para premium.
  useAutoBackup(isLocal && isPremium);
  const [showLogin, setShowLogin] = useState(false);
  const [activeNav, setActiveNav]           = useState(1);
  const [settingsOpen, setSettingsOpen]     = useState(false);
  const [activeSection, setActiveSection]   = useState("colores");
  const [pendingPlayer, setPendingPlayer]   = useState<{ fileId: string; title: string } | null>(null);
  const [notifOpen, setNotifOpen]           = useState(false);
  const [notifUnread, setNotifUnread]       = useState(true);

  // ── Logout con limpieza ─────────────────────────────────────────────────────
  const [showLogoutDialog, setShowLogoutDialog]   = useState(false);
  const [logoutPhase, setLogoutPhase]             = useState<LogoutPhase>("idle");

  const handleLogoutClick = () => {
    // Solo el owner de la instalación tiene datos locales que limpiar
    if (!isLocal || !user?.isOwner) { logout(); return; }
    setShowLogoutDialog(true);
  };

  const doLogout = async () => {
    if (isPremium) {
      setLogoutPhase("backing-up");
      try { await backupService.push(); } catch {}
    }
    setLogoutPhase("wiping");
    try {
      await fetch(`${API_BASE}/api/local/wipe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
    try { await fetch(`${API_BASE}/api/local/owner/reset`, { method: "POST" }); } catch {}
    logout();
    window.location.reload();
  };

  // ── Auto-detect carpeta + alerta de PC no principal (solo premium, isLocal) ──
  const [newMachineAlert, setNewMachineAlert] = useState<{ video_folder: string | null } | null>(null);

  useEffect(() => {
    if (!user || !isPremium || !isLocal) return;
    let cancelled = false;

    backupService.getLocalStatus().then(local => {
      if (cancelled) return;

      // Si ya tiene carpeta configurada en SQLite, esta es la PC original → nada que hacer
      if (local.videosDir) return;

      // No hay carpeta configurada → consultar la nube (por usuario)
      backupService.getCatalog().then(async ({ video_folder, files }) => {
        if (cancelled) return;

        if (video_folder) {
          // Intentar auto-detectar: el backend verifica si la ruta existe en esta máquina
          try {
            const res = await fetch(`${API_BASE}/api/local/setup/auto-detect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ folder: video_folder }),
            });
            const data = await res.json();
            if (data.detected) return; // PC original detectada, carpeta auto-configurada
          } catch {}
        }

        // No se pudo auto-detectar → PC nueva (o sin backup previo)
        if (!cancelled && (files?.length ?? 0) > 0) {
          setNewMachineAlert({ video_folder: video_folder ?? null });
        }
      }).catch(() => {});
    }).catch(() => {});

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.username]);

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
    if (showLogin) return <LoginPage onBack={() => setShowLogin(false)} />;
    return <LandingPage onLogin={() => setShowLogin(true)} />;
  }

  // Editor: navegar solo a Videos, Taller y Calendario
  const role = user.role;
  const visibleSettingsSections = SETTINGS_SECTIONS.filter(s => {
    if (!s.roles.includes(role)) return false;
    if (s.id === "seguridad") return !isLocal && !!user.isOwner;
    if (s.localOnly) return isLocal;
    return true;
  });
  const allowedNavForEditor = new Set([1, 2, 5, 7]); // Videos, Subir, Taller y Calendario

  // Visibilidad de cada item: rol + entorno (en remoto se ocultan las vistas locales).
  const isNavVisible = (i: number) => {
    if (role === "editor" && !allowedNavForEditor.has(i)) return false;
    if (!isLocal && LOCAL_ONLY_NAV.has(i)) return false;
    // En modo móvil, "Subir" (2) solo para quien puede publicar desde el celular
    // (owner ahora; premium cuando se habilite el rollout).
    if (i === 2 && mobileMode && !mobileCanUpload) return false;
    return true;
  };

  // Asegurar que activeNav sea válido para el rol/entorno; si no, caer en Calendario (remoto) o Videos.
  const effectiveNav = isNavVisible(activeNav) ? activeNav : (isLocal ? 1 : 7);

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
            if (!isNavVisible(i)) return null;
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
            <p className="text-[10px] text-muted-foreground/50 font-mono">v{__APP_VERSION__}</p>
          </div>
          <button
            onClick={handleLogoutClick}
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
                <div className="relative">
                  <button
                    onClick={() => { setNotifOpen(v => !v); setNotifUnread(false); }}
                    className="relative text-muted-foreground hover:text-foreground p-1 transition-colors"
                  >
                    <Bell className="w-5 h-5" />
                    {notifUnread && (
                      <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-primary rounded-full" />
                    )}
                  </button>
                  <AnimatePresence>
                    {notifOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
                        <motion.div
                          initial={{ opacity: 0, y: -6, scale: 0.97 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -6, scale: 0.97 }}
                          transition={{ duration: 0.15 }}
                          className="absolute right-0 top-full mt-2 z-50 w-72 bg-card border border-border rounded-xl shadow-xl overflow-hidden"
                        >
                          <div className="px-4 py-3 border-b border-border">
                            <p className="text-xs font-semibold text-foreground uppercase tracking-wider">Notificaciones</p>
                          </div>
                          <div className="px-4 py-6 text-center space-y-1">
                            <Bell className="w-8 h-8 text-muted-foreground/30 mx-auto" />
                            <p className="text-sm text-muted-foreground">Sin notificaciones por ahora.</p>
                            <p className="text-xs text-muted-foreground/60">Próximamente: alertas del día de publicación.</p>
                          </div>
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>
                <button className="hidden sm:flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm hover:bg-primary/90 transition-colors">
                  <Upload className="w-4 h-4" />
                  Subir
                </button>
              </>
            )}
            {/* Logout móvil */}
            <button
              onClick={handleLogoutClick}
              className="sm:hidden text-muted-foreground hover:text-foreground p-1 transition-colors"
              title="Cerrar sesión"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Banner modo remoto */}
        {!isLocal && (
          <div className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-200/90 text-xs sm:text-sm">
            <Tv2 className="w-4 h-4 flex-shrink-0 text-amber-400" />
            <span>
              Modo remoto — funciones limitadas. Para subir y gestionar videos usá la app en tu PC.
            </span>
          </div>
        )}

        {/* Banner modo móvil — el dueño puede publicar desde el celular vía túnel */}
        {mobileMode && mobileCanUpload && (
          <div className="flex items-center gap-2 px-4 py-2 bg-primary/10 border-b border-primary/20 text-primary text-xs">
            <Upload className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Modo móvil — podés publicar tus videos de la PC desde acá.</span>
          </div>
        )}

        {/* Contenido */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0 sm:min-h-screen">
          {effectiveNav === 5
            ? <Taller role={role} isLocal={isLocal} />
            : (
              <main
                className="flex-1 overflow-y-auto overflow-x-hidden px-5 sm:px-10 lg:px-14 py-5 sm:py-7 sm:pb-0"
                style={{ paddingBottom: "max(5rem, calc(env(safe-area-inset-bottom) + 5rem))" }}
              >
                {effectiveNav === 1 ? <VideosView role={role} autoOpenVideo={pendingPlayer} onAutoOpenConsumed={() => setPendingPlayer(null)} />
                  : effectiveNav === 2 ? <YoutubeUploadView />
                  : effectiveNav === 6 ? <SettingsView activeSection={activeSection} role={role} isLocal={isLocal} onSectionChange={setActiveSection} />
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
          {MOBILE_NAV.filter(i => isNavVisible(i)).map((i) => {
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

      {/* ── Banner: PC no principal ─────────────────────────────────────────── */}
      <AnimatePresence>
        {newMachineAlert && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.22 }}
            className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4"
          >
            <div className="flex items-start gap-3 bg-card border border-amber-500/30 rounded-xl shadow-2xl p-4">
              <MonitorOff className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Esta no es tu PC principal</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  Tu catálogo está en la nube, pero los videos físicos no están en este equipo.
                  {newMachineAlert.video_folder && (
                    <span className="block mt-1 font-mono text-[11px] text-muted-foreground/70 truncate">
                      Carpeta original: {newMachineAlert.video_folder}
                    </span>
                  )}
                </p>
              </div>
              <button
                onClick={() => setNewMachineAlert(null)}
                className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Diálogo de logout ───────────────────────────────────────────────── */}
      <AnimatePresence>
        {showLogoutDialog && (
          <LogoutDialog
            isPremium={isPremium}
            phase={logoutPhase}
            onConfirm={doLogout}
            onCancel={() => { if (logoutPhase === "idle") setShowLogoutDialog(false); }}
          />
        )}
      </AnimatePresence>
    </RemoteGate>
  );
}
