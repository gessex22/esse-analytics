import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell, Upload, Clock, Tv2, LogOut, AlertTriangle, Loader2, MonitorOff, X,
} from "lucide-react";
import { Taller } from "./components/Taller";
import { PublishingQueue } from "./components/PublishingQueue";
import { VideosView } from "./components/VideosView";
import { SettingsView } from "./components/SettingsView";
import { LoginPage } from "./components/LoginPage";
import { LandingPage } from "./components/LandingPage";
import { WorkflowSetupModal } from "./components/WorkflowSetupModal";
import { UploadView } from "./components/UploadView";
import { useAuth } from "./hooks/useAuth";
import { RemoteGate } from "./components/RemoteGate";
import { useBackendType } from "./hooks/useBackendType";
import { useIsMobile } from "./hooks/useIsMobile";
import { canPublishOnMobile } from "./lib/mobileMode";
import { useAutoBackup } from "./hooks/useAutoBackup";
import { GemsPanel } from "./components/GemsPanel";
import { UsersPanel } from "./components/UsersPanel";
import { StatsView } from "./components/StatsView";
import { HistoryView } from "./components/HistoryView";
import { Sidebar, MobileNav, navItems, SETTINGS_SECTIONS } from "./components/Sidebar";
import { usePluginActivity, phaseLabel } from "./hooks/usePluginActivity";
import logoImg from "./assets/esseAnalytics.png";
import { backupService } from "./services/api";
import { API_BASE } from "./config";

// Vistas que requieren el dispositivo central (SQLite + archivos físicos).
// En remoto se ocultan: Videos, Subir, Taller, Gemas, Historial.
const LOCAL_ONLY_NAV = new Set([1, 2, 5, 8, 9]);

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
  isPremium, phase, error, onConfirm, onCancel,
}: { isPremium: boolean; phase: LogoutPhase; error: string | null; onConfirm: () => void; onCancel: () => void }) {
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

        {error && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            {error}
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
  const pluginActivity = usePluginActivity(isLocal);
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
  const [userMenuOpen, setUserMenuOpen]     = useState(false);

  // ── Logout con limpieza ─────────────────────────────────────────────────────
  const [showLogoutDialog, setShowLogoutDialog]   = useState(false);
  const [logoutPhase, setLogoutPhase]             = useState<LogoutPhase>("idle");

  const [logoutError, setLogoutError] = useState<string | null>(null);

  const handleLogoutClick = () => {
    // Cualquier sesión local tiene datos locales que limpiar al salir — no depende
    // de isOwner (dueño del SERVICIO, no de esta PC) ni de role (distintas cuentas
    // pueden tener roles distintos): ambos causaban que el wipe nunca se disparara.
    if (!isLocal) { logout(); return; }
    setLogoutError(null);
    setShowLogoutDialog(true);
  };

  const doLogout = async () => {
    if (isPremium) {
      setLogoutPhase("backing-up");
      try { await backupService.push(); } catch {}
    }
    setLogoutPhase("wiping");
    try {
      const res = await fetch(`${API_BASE}/api/local/wipe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || `No se pudo limpiar (HTTP ${res.status}).`);
      }
      await fetch(`${API_BASE}/api/local/owner/reset`, { method: "POST" });
    } catch (err: any) {
      setLogoutPhase("idle");
      setLogoutError(err?.message || "No se pudo limpiar los datos locales. La sesión no se cerró para que puedas reintentar.");
      return;
    }
    logout();
    window.location.reload();
  };

  // ── Auto-detect carpeta + alerta de PC no principal (solo premium, isLocal) ──
  const [newMachineAlert, setNewMachineAlert] = useState<{ video_folder: string | null } | null>(null);

  // ── Setup "simple vs avanzado": se pregunta una sola vez, recién vinculada la instalación ──
  const [showWorkflowSetup, setShowWorkflowSetup] = useState(false);
  useEffect(() => {
    if (!user || !isLocal) return;
    if (localStorage.getItem("esse_pending_workflow_setup") === "1") setShowWorkflowSetup(true);
  }, [user?.username, isLocal]);

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
            if (data.detected) {
              // El catálogo se acaba de reconstruir desde disco (platforms vacío,
              // sin transcripciones). Traemos YA el estado real desde la nube, antes
              // de que el auto-backup (useAutoBackup) tenga chance de pushear el
              // catálogo vacío primero. Las transcripciones no tienen push (no hay
              // otra copia), así que este pull solo rellena lo que falta localmente.
              await Promise.all([
                backupService.pull().catch(() => {}),
                backupService.pullTranscripts().catch(() => {}),
              ]);
              return;
            }
          } catch {}
        }

        // No se pudo auto-detectar → PC nueva (o sin backup previo). Se marca como
        // instalación secundaria para que sus pushes nunca archiven en la nube los
        // videos que solo existen en la PC principal (ver backupService.markSecondary).
        if (!cancelled && (files?.length ?? 0) > 0) {
          setNewMachineAlert({ video_folder: video_folder ?? null });
          backupService.markSecondary().catch(() => {});
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
    if (!isLocal && LOCAL_ONLY_NAV.has(i)) {
      // Excepción: el owner puede publicar en remoto desde el catálogo (la central
      // tiene sus archivos co-localizados y publica por fileId). Solo "Subir" (2);
      // el resto (Videos/Taller/Gemas) sigue siendo local-only.
      if (!(i === 2 && !!user.isOwner)) return false;
    }
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

  return (
    <RemoteGate>
    <div className="flex bg-background text-foreground overflow-hidden" style={{ fontFamily: "'Inter', sans-serif", height: "100dvh" }}>

      <Sidebar
        effectiveNav={effectiveNav}
        settingsOpen={settingsOpen}
        activeSection={activeSection}
        isNavVisible={isNavVisible}
        visibleSettingsSections={visibleSettingsSections}
        onNavClick={handleNavClick}
        onSectionClick={handleSectionClick}
      />

      {/* ── Área principal ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Header */}
        <header className="flex items-center justify-between sm:justify-end px-4 sm:px-6 py-3 sm:py-4 flex-shrink-0 bg-background">

          {/* Mobile: solo logo */}
          <div className="flex items-center gap-2 sm:hidden">
            <img src={logoImg} alt="EsseAnalytics" className="w-8 h-8 flex-shrink-0 rounded-md" />
            <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.02em", fontSize: "0.85rem" }}>
              <span className="text-foreground">Esse</span><span className="text-primary">Analytics</span>
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {pluginActivity && (
              <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary/40 pl-2.5 pr-3 py-1.5 rounded-full max-w-[240px]">
                <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0 text-primary" />
                <span className="truncate">
                  {phaseLabel(pluginActivity.phase)}
                  {pluginActivity.title ? `: ${pluginActivity.title}` : ""}
                  {pluginActivity.current && pluginActivity.total ? ` (${pluginActivity.current}/${pluginActivity.total})` : ""}
                </span>
              </div>
            )}
            {role === "todopoderoso" && (
              <div className="relative">
                <button
                  onClick={() => { setNotifOpen(v => !v); setNotifUnread(false); }}
                  className="relative flex items-center justify-center w-9 h-9 rounded-full bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors"
                >
                  <Bell className="w-4 h-4" />
                  {notifUnread && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full" />
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
            )}

            {/* Cuenta de usuario, como chip con menú */}
            <div className="hidden sm:block relative">
              <button
                onClick={() => setUserMenuOpen(v => !v)}
                className="flex items-center gap-2 rounded-full bg-secondary/40 hover:bg-secondary/70 transition-colors pl-1.5 pr-3 py-1.5"
              >
                <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-[10px] font-semibold flex-shrink-0">
                  {user.username[0].toUpperCase()}
                </div>
                <span className="text-sm font-medium text-foreground truncate max-w-[100px]">{user.username}</span>
              </button>
              <AnimatePresence>
                {userMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: -6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 top-full mt-2 z-50 w-48 bg-card border border-border rounded-xl shadow-xl overflow-hidden"
                    >
                      <div className="px-4 py-3 border-b border-border">
                        <p className="text-sm font-medium text-foreground truncate">{user.username}</p>
                        <p className="text-xs text-muted-foreground capitalize">{user.role} · v{__APP_VERSION__}</p>
                      </div>
                      <button
                        onClick={() => { setUserMenuOpen(false); handleLogoutClick(); }}
                        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Cerrar sesión
                      </button>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

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
            ? <Taller role={role} />
            : (
              <main
                className="flex-1 overflow-y-auto overflow-x-hidden px-5 sm:px-10 lg:px-14 py-5 sm:py-7 sm:pb-0"
                style={{ paddingBottom: "max(5rem, calc(env(safe-area-inset-bottom) + 5rem))" }}
              >
                {effectiveNav === 1 ? <VideosView role={role} autoOpenVideo={pendingPlayer} onAutoOpenConsumed={() => setPendingPlayer(null)} />
                  : effectiveNav === 2 ? <UploadView />
                  : effectiveNav === 6 ? <SettingsView activeSection={activeSection} role={role} isLocal={isLocal} isPremium={isPremium} onSectionChange={setActiveSection} onOpenVideo={openVideoPlayer} />
                  : effectiveNav === 7 ? <PublishingQueue role={role} onOpenVideo={openVideoPlayer} />
                  : effectiveNav === 3 ? (user.isOwner ? <UsersPanel /> : <ProximamenteView label="Usuarios" />)
                  : effectiveNav === 4 ? <StatsView onOpenVideo={openVideoPlayer} />
                  : effectiveNav === 8 ? <GemsPanel isLocal={isLocal} userTier={user.isOwner ? "premium" : user.tier} />
                  : effectiveNav === 9 ? <HistoryView onOpenVideo={openVideoPlayer} />
                  : <ProximamenteView label={navItems[effectiveNav]?.label ?? ""} />
                }
              </main>
            )
          }
        </div>

        <MobileNav effectiveNav={effectiveNav} isNavVisible={isNavVisible} onNavClick={handleNavClick} />
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

      {/* ── Setup inicial: flujo simple vs avanzado (una sola vez) ───────────── */}
      {showWorkflowSetup && (
        <WorkflowSetupModal
          onDone={() => {
            localStorage.removeItem("esse_pending_workflow_setup");
            setShowWorkflowSetup(false);
          }}
        />
      )}

      {/* ── Diálogo de logout ───────────────────────────────────────────────── */}
      <AnimatePresence>
        {showLogoutDialog && (
          <LogoutDialog
            isPremium={isPremium}
            phase={logoutPhase}
            error={logoutError}
            onConfirm={doLogout}
            onCancel={() => { if (logoutPhase === "idle") setShowLogoutDialog(false); }}
          />
        )}
      </AnimatePresence>
    </RemoteGate>
  );
}
