import { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bell, Upload, Clock, Tv2, LogOut, AlertTriangle, Loader2, MonitorOff, X, FolderOpen,
} from "lucide-react";
import { Taller } from "./components/Taller";
import { PublishingQueue } from "./components/PublishingQueue";
import { VideosView } from "./components/VideosView";
import { RemoteLibraryView } from "./components/RemoteLibraryView";
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
import { useSyncOrchestrator } from "./hooks/useSyncOrchestrator";
import { GemsPanel } from "./components/GemsPanel";
import { UsersPanel } from "./components/UsersPanel";
import { StatsView } from "./components/StatsView";
import { DashboardView } from "./components/DashboardView";
import { HistoryView } from "./components/HistoryView";
import { Sidebar, MobileNav, NAV_ORDER, navItems } from "./components/Sidebar";
import { ViewShell } from "./components/ViewShell";
import { useNotificationCenter } from "./hooks/useNotificationCenter";
import logoImg from "./assets/esseAnalytics.png";
import { backupService, videoService } from "./services/api";
import { API_BASE } from "./config";

// Vistas que requieren el dispositivo central (SQLite + archivos físicos).
// En remoto se ocultan: Videos, Subir, Taller, Gemas. Historial ya no está acá --
// ahora tiene fuente central (GET /api/sync/history sobre BackupPlatformVideoModel)
// para verse igual desde Android/iPhone/web que desde el escritorio.
const LOCAL_ONLY_NAV = new Set([1, 2, 5, 8]);

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
  const { isLocal, isLabMode, pendingHistoryEvents } = useBackendType();
  const { notifications, cloudOpen, unread: notifUnread, markRead } = useNotificationCenter(isLocal);
  const isMobile = useIsMobile();
  const isPremium = !!user && (user.isOwner || user.tier === "premium");

  // Modo móvil: teléfono hablando con el backend local (vía túnel Acceso Remoto o LAN).
  // En ese contexto la publicación se restringe a quien tenga permiso (owner ahora,
  // premium cuando se active el flag en lib/mobileMode).
  const mobileMode      = isMobile && isLocal;
  const mobileCanUpload = canPublishOnMobile(user);

  // Sync automático (push + pull + precargado a Biblioteca remota): solo en
  // el dispositivo central y para premium.
  useSyncOrchestrator(isLocal && isPremium);
  const [showLogin, setShowLogin] = useState(false);
  const [activeNav, setActiveNav]           = useState(0);
  const [navigationDirection, setNavigationDirection] = useState<1 | -1>(1);
  const contentScrollRef = useRef<HTMLElement | null>(null);
  const viewScrollPositions = useRef<Record<number, number>>({});
  const [pendingPlayer, setPendingPlayer]   = useState<{ fileId: string; title: string } | null>(null);
  const [notifOpen, setNotifOpen]           = useState(false);
  const [userMenuOpen, setUserMenuOpen]     = useState(false);

  // ── Alto real de banners, publicado como variable CSS ──────────────────────
  // --app-chrome-top nunca se calcula a mano (ni por cantidad de banners ni por
  // breakpoint): un ResizeObserver mide el contenedor de verdad, así que cuando
  // el banner de Laboratorio (u otro) no está montado, el valor baja solo sin
  // dejar hueco -- y si algún día se agrega otro banner, o el texto pasa a 2
  // líneas en una ventana angosta, el valor sigue siendo exacto sin tocar esta
  // lógica. El header flotante queda fuera del flujo y usa este valor como su
  // posición superior para aparecer debajo de cualquier banner activo. El
  // scroll vive en <main>, así que las píldoras permanecen visibles mientras
  // el contenido pasa por debajo.
  //
  // Callback ref, no useRef+useEffect: este componente tiene returns
  // condicionales tempranos (loading/login) ANTES de llegar al JSX que monta
  // este div -- un useEffect con deps [] correría una sola vez mientras el
  // ref todavía es null (pantalla de carga) y nunca se reconectaría después
  // del login. Un callback ref se re-ejecuta solo cada vez que el nodo se
  // monta/desmonta, sin ese problema.
  const chromeObserverRef = useRef<ResizeObserver | null>(null);
  const setChromeRef = useCallback((el: HTMLDivElement | null) => {
    chromeObserverRef.current?.disconnect();
    chromeObserverRef.current = null;
    if (!el) return;
    const publish = () => document.documentElement.style.setProperty("--app-chrome-top", `${el.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    chromeObserverRef.current = observer;
  }, []);

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
              // de que el sync automático (useSyncOrchestrator) tenga chance de pushear el
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

  // ── Aviso "configurá tu carpeta de videos" (cuenta todopoderoso sin biblioteca) ──
  // A diferencia del newMachineAlert de arriba (solo premium, para restaurar desde
  // la nube), este es el caso más simple: una cuenta nueva -- real o del Laboratorio,
  // ver lab_environment_project -- que todavía no tiene NINGUNA carpeta configurada
  // en esta PC. Sin este aviso, el único lugar para configurarla es Ajustes >
  // Biblioteca, y nada lleva ahí si no sabés que existe.
  const [needsVideoFolder, setNeedsVideoFolder] = useState(false);
  useEffect(() => {
    if (!user || !isLocal || user.role !== "todopoderoso") { setNeedsVideoFolder(false); return; }
    let cancelled = false;
    backupService.getLocalStatus()
      .then(local => { if (!cancelled) setNeedsVideoFolder(!local.videosDir); })
      .catch(() => {});
    return () => { cancelled = true; };
  // Se re-chequea también al cambiar de pestaña -- así, si configuraste la
  // carpeta en Ajustes y volvés a Resumen, el aviso desaparece sin necesitar
  // recargar toda la app.
  }, [user?.username, isLocal, activeNav]);

  // ── Rol de instalación: primaria/secundaria ───────────────────────────────────
  // docs/primary-install-corrected-plan-2026-08-14.md, Fase E. La central decide
  // (nunca el cliente, mismo criterio que bulkUpsertBackupFiles del lado
  // backend) -- esto solo refleja esa respuesta para la UI. El gate real
  // (que una secundaria no pueda escanear/configurar carpeta) ya está
  // aplicado server-side en local-backend con o sin esto; acá se oculta nav
  // local y se ofrece "reclamar como principal".
  const [installationRole, setInstallationRole] = useState<"primary" | "secondary" | null>(null);
  useEffect(() => {
    if (!user || !isLocal) { setInstallationRole(null); return; }
    let cancelled = false;
    backupService.getInstallationStatus()
      .then(({ role }) => { if (!cancelled) setInstallationRole(role); })
      .catch(() => {}); // central inalcanzable: no bloquea la UI, se reintenta en el próximo login/tab
    return () => { cancelled = true; };
  }, [user?.username, isLocal]);
  const isSecondaryInstall = installationRole === "secondary";
  const [secondaryBannerDismissed, setSecondaryBannerDismissed] = useState(false);

  const [claimModalOpen, setClaimModalOpen] = useState(false);
  const [claimPassword, setClaimPassword]   = useState("");
  const [claimBusy, setClaimBusy]           = useState(false);
  const [claimError, setClaimError]         = useState<string | null>(null);
  const handleClaimPrimary = async () => {
    if (!claimPassword) return;
    setClaimBusy(true); setClaimError(null);
    try {
      await backupService.claimPrimary(claimPassword);
      setInstallationRole("primary");
      setClaimModalOpen(false);
      setClaimPassword("");
    } catch (err: any) {
      setClaimError(err.message || "No se pudo reclamar esta PC como principal.");
    } finally {
      setClaimBusy(false);
    }
  };

  // ── Aviso "publicás hoy" (calendario, al iniciar sesión) ──────────────────────
  // Distinto de la sección "Hoy" que ya muestra PublishingQueue -- ese aviso solo
  // lo ve quien entra a Calendario; este es la notificación global que pedía el
  // pending_tasks_roadmap ("alerta del día de publicación al iniciar sesión").
  // No es local-only: el calendario ya sincroniza con la central (ver LOCAL_ONLY_NAV),
  // así que se muestra igual en remoto -- la acción de publicar en sí no lo es.
  const [publishToday, setPublishToday] = useState<{ title: string; count: number } | null>(null);
  useEffect(() => {
    if (!user) { setPublishToday(null); return; }
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    // Un solo aviso por día y por cuenta -- si lo cerrás, no vuelve a aparecer hasta
    // mañana (mismo criterio que showWorkflowSetup: no molestar de nuevo en la sesión).
    if (localStorage.getItem(`esse_pubToday_dismissed_${user.username}_${todayKey}`) === "1") return;
    let cancelled = false;
    videoService.getCalendarVideos(now.getFullYear(), now.getMonth() + 1)
      .then(videos => {
        if (cancelled) return;
        // date = effective_date del servidor (scheduled_date si existe, si no la
        // fecha de creación) -- puede venir con hora, por eso se compara solo el
        // prefijo de fecha. "completo" = ya publicado en todo lo agendado, no avisar.
        const pending = videos.filter(v => v.date?.slice(0, 10) === todayKey && v.calendarStatus !== "completo");
        if (pending.length > 0) setPublishToday({ title: pending[0].title, count: pending.length });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user?.username]);

  const dismissPublishToday = () => {
    if (user) {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      localStorage.setItem(`esse_pubToday_dismissed_${user.username}_${todayKey}`, "1");
    }
    setPublishToday(null);
  };
  const goToCalendar = () => { setPublishToday(null); handleNavClick(7); };

  const [settingsInitialSection, setSettingsInitialSection] = useState<string | null>(null);
  const goToLibrarySettings = () => {
    setSettingsInitialSection("biblioteca");
    handleNavClick(6);
  };
  // Se limpia al salir de Ajustes -- si no, una visita posterior CUALQUIERA
  // (por el menú normal, no por este aviso) seguiría saltando directo a
  // Biblioteca en vez de abrir la lista de secciones como siempre.
  useEffect(() => {
    if (activeNav !== 6) setSettingsInitialSection(null);
  }, [activeNav]);

  function openVideoPlayer(fileId: string, title: string) {
    setPendingPlayer({ fileId, title });
    handleNavClick(1);
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

  // Editor: navegar solo a Videos, Subir, Taller, Calendario y Nube
  const role = user.role;
  const allowedNavForEditor = new Set([1, 2, 5, 7, 10]);

  // Visibilidad de cada item: rol + entorno (en remoto se ocultan las vistas locales).
  const isNavVisible = (i: number) => {
    if (role === "editor" && !allowedNavForEditor.has(i)) return false;
    // Nube (10) NO es local-only: vive tanto en el cliente de Electron como en
    // acceso remoto (celular/navegador) -- el único gate real es tener el plan de
    // storage en la nube, sin importar isLocal. Por eso queda afuera de LOCAL_ONLY_NAV.
    if (i === 10) return !!user.hasCloudStorage;
    // isSecondaryInstall: mismo gate duro que el modo remoto -- una PC
    // secundaria no tiene catálogo físico propio (docs/primary-install-corrected-plan-2026-08-14.md,
    // Fase E), así que Videos/Subir/Taller/Gemas se ocultan igual que en
    // remoto. La excepción de "Subir" para el owner remoto no aplica acá
    // todavía (necesitaría la subida ad-hoc de la Fase G, sin implementar).
    if ((!isLocal || isSecondaryInstall) && LOCAL_ONLY_NAV.has(i)) {
      // Excepción: el owner puede publicar en remoto desde el catálogo (la central
      // tiene sus archivos co-localizados y publica por fileId). Solo "Subir" (2);
      // el resto (Videos/Taller/Gemas) sigue siendo local-only.
      if (!(i === 2 && !!user.isOwner && !isSecondaryInstall)) return false;
    }
    // En modo móvil, "Subir" (2) solo para quien puede publicar desde el celular
    // (owner ahora; premium cuando se habilite el rollout).
    if (i === 2 && mobileMode && !mobileCanUpload) return false;
    return true;
  };

  // Asegurar que activeNav sea válido para el rol/entorno; si no, caer en Nube (remoto
  // con storage en la nube), Calendario (remoto sin storage) o Videos (local).
  const effectiveNav = isNavVisible(activeNav) ? activeNav
    : isLocal ? 0
    : user.hasCloudStorage ? 10
    : 7;

  const handleNavClick = (i: number) => {
    if (contentScrollRef.current) viewScrollPositions.current[effectiveNav] = contentScrollRef.current.scrollTop;
    // La dirección sigue el orden que el usuario VE en el sidebar, no los
    // índices históricos de navItems (que ya no están ordenados visualmente).
    const currentPosition = NAV_ORDER.indexOf(effectiveNav);
    const nextPosition = NAV_ORDER.indexOf(i);
    setNavigationDirection(nextPosition >= currentPosition ? 1 : -1);
    setActiveNav(i);
  };

  // No se restaura en un useEffect atado a effectiveNav: con
  // AnimatePresence mode="wait" la vista saliente sigue montada (haciendo su
  // animación de salida) en el momento en que effectiveNav ya cambió, así que
  // ese scrollTop se aplicaría sobre el contenido viejo -- un salto visible
  // antes de que desaparezca. Se aplica recién cuando esa salida terminó (ver
  // onExitComplete más abajo), momento en el que la vista nueva ya se montó.
  const restoreScrollForNav = (nav: number) => {
    const target = contentScrollRef.current;
    if (target) target.scrollTop = viewScrollPositions.current[nav] ?? 0;
  };

  const viewMeta: Record<number, { title: string; description?: string; width?: "compact" | "default" | "wide" }> = {
    0: { title: "Resumen", description: "Una mirada rápida a tu contenido publicado y lo que viene." },
    1: { title: "Videos", description: "Gestioná tu catálogo y la cola de publicación." },
    2: { title: "Subir", description: "Prepará y publicá contenido en tus plataformas." },
    3: { title: "Usuarios" },
    4: { title: "Estadísticas", description: "Rendimiento reciente de tu contenido." },
    5: { title: "Taller", description: "Versiones y borradores de cada video original." },
    6: { title: "Ajustes", description: "Configurá tu espacio de trabajo.", width: "compact" },
    7: { title: "Calendario", description: "Organizá lo próximo que vas a publicar." },
    8: { title: "Gemas" },
    9: { title: "Historial", description: "Registro de publicaciones realizadas desde la app." },
    10: { title: "Biblioteca remota", description: "Videos guardados en la nube.", width: "wide" },
  };

  return (
    <RemoteGate>
    <div className="flex bg-background text-foreground overflow-hidden" style={{ fontFamily: "'Inter', sans-serif", height: "100dvh" }}>

      <Sidebar
        effectiveNav={effectiveNav}
        isNavVisible={isNavVisible}
        onNavClick={handleNavClick}
      />

      {/* ── Área principal ─────────────────────────────────────────────────── */}
      <div className="relative flex-1 flex flex-col overflow-hidden min-w-0">

        {/* Banners apilables (Laboratorio, remoto, carpeta pendiente, móvil).
            Se mide con ResizeObserver (ver setChromeRef más arriba) y se publica
            en --app-chrome-top -- así cualquier vista puede saber el alto REAL de
            los banners sin adivinar un número. El header usa ese mismo valor para
            flotar inmediatamente debajo de ellos. */}
        <div ref={setChromeRef}>
        {/* Header */}
        <header
          className="absolute inset-x-0 z-30 flex items-center justify-between sm:justify-end px-4 sm:px-6 py-3 sm:py-4"
          style={{ top: "var(--app-chrome-top)" }}
        >

          {/* Mobile: solo logo */}
          <div className="flex items-center gap-2 sm:hidden">
            <img src={logoImg} alt="EsseAnalytics" className="w-8 h-8 flex-shrink-0 rounded-md" />
            <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, letterSpacing: "-0.02em", fontSize: "0.85rem" }}>
              <span className="text-foreground">Esse</span><span className="text-primary">Analytics</span>
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="relative h-9">
              {/* Clon del círculo gris de la campana: se estira hacia la izquierda
                  (mismo alto/centro que el botón) cuando llega una novedad, y vuelve
                  a su tamaño original solo con el botón de campana encima tapando el
                  extremo derecho. El punto de "no leído" recién reaparece cuando el
                  clon terminó de encogerse. */}
              <motion.div
                className="absolute top-0 right-0 z-0 h-9 rounded-full bg-secondary/40 border overflow-hidden flex items-center justify-end whitespace-nowrap pointer-events-none"
                initial={false}
                animate={{
                  width: cloudOpen && notifications.length > 0 ? 260 : 36,
                  borderColor: cloudOpen && notifications.length > 0 ? "var(--primary)" : "transparent",
                }}
                transition={{ duration: 0.45, ease: [0.34, 1.56, 0.64, 1] }}
              >
                <AnimatePresence>
                  {cloudOpen && notifications.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ delay: 0.15, duration: 0.15 }}
                      className="flex items-center gap-1.5 pl-3 text-xs text-foreground"
                      style={{ paddingRight: 44 }}
                    >
                      {notifications[0].status === "running" ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0 text-primary" />
                      ) : notifications[0].status === "error" ? (
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 text-red-400" />
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                      )}
                      <span className="truncate">{notifications[0].label}</span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>

              <button
                onClick={() => { setNotifOpen(v => !v); markRead(); }}
                className="relative z-10 flex items-center justify-center w-9 h-9 rounded-full bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors"
              >
                <Bell className="w-4 h-4" />
                {notifUnread && !cloudOpen && (
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
                      {notifications.length === 0 ? (
                        <div className="px-4 py-6 text-center space-y-1">
                          <Bell className="w-8 h-8 text-muted-foreground/30 mx-auto" />
                          <p className="text-sm text-muted-foreground">Sin notificaciones por ahora.</p>
                          <p className="text-xs text-muted-foreground/60">Próximamente: alertas del día de publicación.</p>
                        </div>
                      ) : (
                        <div className="max-h-80 overflow-y-auto divide-y divide-border">
                          {notifications.map(n => (
                            <div key={n.id} className="flex items-center gap-2 px-4 py-3 text-xs">
                              {n.status === "running" ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0 text-primary" />
                              ) : n.status === "error" ? (
                                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 text-red-400" />
                              ) : (
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                              )}
                              <span className={`truncate ${n.status === "error" ? "text-red-300" : "text-foreground"}`}>{n.label}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

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

        {/* Banner de Laboratorio -- persistente, nunca se puede ignorar por accidente.
            isLabMode solo puede ser true si el local-backend al que hablamos arrancó
            con ESSENALYTICS_LAB_MODE=1 (ver useBackendType.ts) -- nunca aparece
            hablando con la central real ni con un local-backend normal. */}
        {isLabMode && (
          <div className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-violet-500/15 border-b border-violet-500/30 text-violet-200 text-xs sm:text-sm font-medium">
            <span aria-hidden>🧪</span>
            <span>Laboratorio · Datos simulados</span>
          </div>
        )}

        {/* Banner modo remoto */}
        {!isLocal && (
          <div className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-200/90 text-xs sm:text-sm">
            <Tv2 className="w-4 h-4 flex-shrink-0 text-amber-400" />
            <span>
              {user.hasCloudStorage
                ? "Modo remoto — funciones limitadas, pero podés subir y gestionar tu Biblioteca en la nube desde la pestaña «Nube»."
                : "Modo remoto — funciones limitadas. Para subir y gestionar videos usá la app en tu PC."}
            </span>
          </div>
        )}

        {/* Outbox de historial (BUG-2026-08-15-07): antes, si el POST a la
            central fallaba (red, token vencido, 500), el evento se perdía en
            silencio -- Electron seguía mostrando la publicación bien (lee su
            propia SQLite) pero web/iOS/Android nunca se enteraban, sin
            ningún aviso. Ahora queda encolado y se reintenta solo, pero
            mientras haya algo pendiente vale la pena mostrarlo en vez de
            ocultar el fallo -- isLocal porque el outbox es un concepto de
            local-backend, no existe en modo remoto/central. */}
        {isLocal && pendingHistoryEvents > 0 && (
          <div className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-sky-500/10 border-b border-sky-500/20 text-sky-200/90 text-xs sm:text-sm">
            <Tv2 className="w-4 h-4 flex-shrink-0 text-sky-400" />
            <span>
              {pendingHistoryEvents === 1
                ? "1 publicación pendiente de sincronizar con la nube — se reintenta sola."
                : `${pendingHistoryEvents} publicaciones pendientes de sincronizar con la nube — se reintentan solas.`}
            </span>
          </div>
        )}

        {/* Aviso: cuenta todopoderoso local sin carpeta de videos configurada todavía
            (cuenta nueva real, o de Laboratorio -- ver [[lab_environment_project]]).
            No se muestra si ya hay newMachineAlert/showWorkflowSetup abiertos, para
            no apilar 3 avisos a la vez sobre lo mismo. */}
        {needsVideoFolder && !newMachineAlert && !showWorkflowSetup && (
          <div className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-primary/10 border-b border-primary/20 text-primary text-xs sm:text-sm">
            <FolderOpen className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1">Todavía no configuraste tu carpeta de videos — sin eso, la app no tiene nada para mostrar.</span>
            <button
              onClick={goToLibrarySettings}
              className="underline font-medium hover:no-underline flex-shrink-0"
            >
              Configurar ahora
            </button>
          </div>
        )}

        {/* Aviso: hay algo agendado para publicar hoy en el Calendario. Mismo slot
            que el de arriba (uno a la vez) -- si no hay carpeta configurada ese
            aviso tiene prioridad, no tiene sentido avisar de publicar sin biblioteca. */}
        {publishToday && !needsVideoFolder && !newMachineAlert && !showWorkflowSetup && (
          <div className="flex items-center gap-2 px-4 sm:px-6 py-2 bg-primary/10 border-b border-primary/20 text-primary text-xs sm:text-sm">
            <Bell className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1 truncate">
              {publishToday.count === 1
                ? <>Hoy toca publicar: <span className="font-medium">{publishToday.title}</span></>
                : <>Hoy tenés <span className="font-medium">{publishToday.count} videos</span> agendados para publicar.</>}
            </span>
            <button onClick={goToCalendar} className="underline font-medium hover:no-underline flex-shrink-0">
              Ver calendario
            </button>
            <button onClick={dismissPublishToday} className="flex-shrink-0 opacity-70 hover:opacity-100" aria-label="Cerrar aviso">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Banner modo móvil — el dueño puede publicar desde el celular vía túnel */}
        {mobileMode && mobileCanUpload && (
          <div className="flex items-center gap-2 px-4 py-2 bg-primary/10 border-b border-primary/20 text-primary text-xs">
            <Upload className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Modo móvil — podés publicar tus videos de la PC desde acá.</span>
          </div>
        )}
        </div>

        {/* Contenido. Solo <main> hace scroll: el header queda fuera del flujo,
            sin superficie propia, mientras la campana y el chip permanecen
            flotando por encima de la página. */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          <main
                ref={contentScrollRef}
                className="flex-1 overflow-y-auto overflow-x-hidden px-5 sm:px-10 lg:px-14 pt-16 pb-5 sm:pt-7 sm:pb-0"
                style={{ paddingBottom: "var(--app-bottom-safe)" }}
              >
                <AnimatePresence mode="wait" initial={false} custom={navigationDirection} onExitComplete={() => restoreScrollForNav(effectiveNav)}>
                  <ViewShell key={effectiveNav} viewKey={effectiveNav} direction={navigationDirection} {...viewMeta[effectiveNav]}>
                  {effectiveNav === 0 ? <DashboardView onOpenVideo={openVideoPlayer} onOpenCalendar={() => handleNavClick(7)} />
                  : effectiveNav === 1 ? <VideosView role={role} autoOpenVideo={pendingPlayer} onAutoOpenConsumed={() => setPendingPlayer(null)} onOpenCloud={user.hasCloudStorage ? () => handleNavClick(10) : undefined} />
                  : effectiveNav === 2 ? <UploadView onOpenHistory={() => handleNavClick(9)} />
                  : effectiveNav === 6 ? <SettingsView role={role} isLocal={isLocal} isPremium={isPremium} isOwner={!!user.isOwner} onOpenVideo={openVideoPlayer} initialSection={settingsInitialSection} />
                  : effectiveNav === 7 ? <PublishingQueue role={role} onOpenVideo={openVideoPlayer} />
                  : effectiveNav === 3 ? (user.isOwner ? <UsersPanel /> : <ProximamenteView label="Usuarios" />)
                  : effectiveNav === 4 ? <StatsView onOpenVideo={openVideoPlayer} />
                  : effectiveNav === 8 ? <GemsPanel isLocal={isLocal} userTier={user.isOwner ? "premium" : user.tier} />
                  : effectiveNav === 9 ? <HistoryView onOpenVideo={openVideoPlayer} />
                  : effectiveNav === 10 ? <RemoteLibraryView />
                  : <ProximamenteView label={navItems[effectiveNav]?.label ?? ""} />
                  }
                  </ViewShell>
                </AnimatePresence>
              </main>
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

      {/* ── Banner: PC secundaria (docs/primary-install-corrected-plan-2026-08-14.md) ── */}
      <AnimatePresence>
        {isSecondaryInstall && !secondaryBannerDismissed && (
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
                <p className="text-sm font-semibold text-foreground">Esta PC es secundaria</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
                  Otra instalación ya es la principal de tu cuenta. Acá no podés escanear ni
                  configurar la carpeta de videos hasta que la reclames.
                </p>
                <button
                  onClick={() => setClaimModalOpen(true)}
                  className="mt-2 text-xs font-semibold text-primary hover:underline"
                >
                  Reclamar esta PC como principal
                </button>
              </div>
              <button
                onClick={() => setSecondaryBannerDismissed(true)}
                className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Modal: reclamar esta PC como principal ────────────────────────────── */}
      <AnimatePresence>
        {claimModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center px-4"
            onClick={() => { if (!claimBusy) { setClaimModalOpen(false); setClaimError(null); } }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="bg-card border border-border rounded-xl shadow-2xl p-5 w-full max-w-sm"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-sm font-semibold text-foreground">Reclamar esta PC como principal</h3>
              <p className="text-xs text-muted-foreground mt-1 leading-snug">
                Esto reemplaza la instalación principal actual. Confirmá tu contraseña para continuar.
              </p>
              <input
                type="password"
                autoFocus
                value={claimPassword}
                onChange={e => setClaimPassword(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleClaimPrimary(); }}
                placeholder="Contraseña actual"
                className="mt-3 w-full px-3 py-2 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
              />
              {claimError && (
                <p className="mt-2 text-xs text-red-400 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {claimError}
                </p>
              )}
              <div className="mt-4 flex gap-2 justify-end">
                <button
                  onClick={() => { setClaimModalOpen(false); setClaimError(null); setClaimPassword(""); }}
                  disabled={claimBusy}
                  className="text-xs px-3 py-2 rounded-lg text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleClaimPrimary}
                  disabled={claimBusy || !claimPassword}
                  className="text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 flex items-center gap-1.5"
                >
                  {claimBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Reclamar
                </button>
              </div>
            </motion.div>
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
