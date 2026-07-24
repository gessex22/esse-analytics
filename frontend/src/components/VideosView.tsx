import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Film,
  Eye,
  ThumbsUp,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Check,
  Pencil,
  X,
  Trash2,
  Loader2,
  MonitorOff,
  CalendarClock,
  Link2,
  Cloud,
  Database,
} from "lucide-react";
import { videoService, backupService, setupService, formatDurationFromSeconds, deriveRatio, DashboardVideo, PaginationInfo, WorkflowMode, SyncStatusEntry } from "../services/api";
import { runSyncTick } from "../services/syncOrchestrator";
import { VideoModal } from "./player/VideoModal";
import { Skeleton } from "./ui/skeleton";
import { Chip } from "./ui/chip";

// ── Tipos ─────────────────────────────────────────────────────────────────────
type TipoFilter = "" | "GUION_ESTRUCTURADO" | "CLIP_RANDOM" | "CLIP_SIN_VOZ";

// ── Filtro de publicación (derivado de platforms, NO de content_status) ───────
type PubFilter = "sin_publicar" | "parcial" | "completo";
const PUB_FILTER_LABELS: Record<PubFilter, string> = {
  sin_publicar: "Sin publicar",
  parcial:      "Parciales",
  completo:     "Completos",
};

type Platform = "youtube" | "instagram" | "tiktok";
type PlatformState = "publicado" | "descartado" | "pendiente";
const ALL_PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

// ── Flujo "simple": un solo estado agregado para las 3 plataformas ────────────
function aggregatePlatformState(v: { platforms: string[]; platforms_discarded: string[] }): PlatformState {
  if (ALL_PLATFORMS.every((p) => v.platforms.includes(p))) return "publicado";
  if (ALL_PLATFORMS.every((p) => v.platforms_discarded.includes(p))) return "descartado";
  return "pendiente";
}
const nextPlatformState = (s: PlatformState): PlatformState =>
  s === "pendiente" ? "publicado" : s === "publicado" ? "descartado" : "pendiente";


// ── Iconos de plataforma ──────────────────────────────────────────────────────
function YoutubeIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`w-4 h-4 transition-opacity ${active ? "fill-red-500 opacity-100" : "fill-muted-foreground opacity-25"}`}>
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}
function InstagramIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`w-4 h-4 transition-opacity ${active ? "fill-pink-500 opacity-100" : "fill-muted-foreground opacity-25"}`}>
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
    </svg>
  );
}
function TiktokIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`w-4 h-4 transition-opacity ${active ? "fill-white opacity-100" : "fill-muted-foreground opacity-25"}`}>
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.76a4.85 4.85 0 0 1-1.01-.07z" />
    </svg>
  );
}

// ── Icono de plataforma con 3 estados ────────────────────────────────────────
function PlatformBadge({
  platform, state, onClick,
}: { platform: Platform; state: PlatformState; onClick?: () => void }) {
  const Icon = platform === "youtube" ? YoutubeIcon : platform === "instagram" ? InstagramIcon : TiktokIcon;
  const active = state === "publicado";
  const titles: Record<PlatformState, string> = {
    publicado:  `${platform} · Publicado — clic para descartar`,
    descartado: `${platform} · Descartado — clic para restablecer`,
    pendiente:  `${platform} · Pendiente — clic para marcar publicado`,
  };
  const inner = (
    <span className="relative inline-flex items-center justify-center">
      <Icon active={active} />
      {state === "descartado" && (
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="absolute w-[140%] h-px bg-muted-foreground/60 -rotate-45 left-[-20%]" />
        </span>
      )}
    </span>
  );
  if (!onClick) return inner;
  return (
    <button
      onClick={onClick}
      title={titles[state]}
      className="transition-transform hover:scale-110 active:scale-95"
    >
      {inner}
    </button>
  );
}

// ── Estado único para flujo "simple" (agrega las 3 plataformas) ──────────────
const SIMPLE_STATE_LABELS: Record<PlatformState, string> = {
  publicado:  "Publicado",
  descartado: "Descartado",
  pendiente:  "Pendiente",
};
const SIMPLE_STATE_STYLES: Record<PlatformState, string> = {
  publicado:  "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  descartado: "bg-secondary text-muted-foreground border-border line-through",
  pendiente:  "bg-secondary/60 text-muted-foreground border-border",
};
function SimpleStatusBadge({ state, onClick }: { state: PlatformState; onClick?: () => void }) {
  const label = SIMPLE_STATE_LABELS[state];
  const cls = `text-[11px] font-medium px-2 py-1 rounded-full border transition-colors ${SIMPLE_STATE_STYLES[state]}`;
  if (!onClick) return <span className={cls}>{label}</span>;
  return (
    <button onClick={onClick} title={`${label} — clic para cambiar`} className={`${cls} hover:brightness-110`}>
      {label}
    </button>
  );
}

// ── Miniatura (ffmpeg local) con fallback al ícono si no se pudo generar ──────
// Usa fetch (no <img src>) para poder leer X-Duration-Seconds del response y
// avisarle a la fila su duración real apenas se resuelve — si no, la lista
// solo se autocorrige recargando la página entera (el fetch de la lista ya
// había terminado antes de que esta miniatura backfilleara la duración).
function VideoThumb({ fileId, onDuration, onResolution }: {
  fileId?: string; onDuration?: (sec: number) => void; onResolution?: (res: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!fileId) return;
    let objectUrl: string | null = null;
    let cancelled = false;

    fetch(videoService.thumbnailUrl(fileId))
      .then((r) => {
        if (!r.ok) throw new Error("sin miniatura");
        const dur = Number(r.headers.get("X-Duration-Seconds"));
        if (Number.isFinite(dur) && dur > 0) onDuration?.(dur);
        const res = r.headers.get("X-Resolution");
        if (res) onResolution?.(res);
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);

  if (!fileId || failed || !src) return <Film className="w-5 h-5 text-muted-foreground/40" />;
  return <img src={src} alt="" className="w-full h-full object-cover" onError={() => setFailed(true)} />;
}

// ── Skeleton de lista (imita el layout real para evitar el salto de carga) ────
function VideoListSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="bg-card border border-border rounded-xl divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          {/* Número (desktop) */}
          <Skeleton className="hidden sm:block w-6 h-4 flex-shrink-0" />
          {/* Miniatura */}
          <Skeleton className="w-20 h-12 sm:w-24 sm:h-14 rounded-lg flex-shrink-0" />
          {/* Título + metadata */}
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-3.5 rounded" style={{ width: `${55 + ((i * 7) % 35)}%` }} />
            <div className="flex items-center gap-2">
              <Skeleton className="h-2.5 w-16 rounded" />
              <Skeleton className="h-2.5 w-10 rounded" />
            </div>
          </div>
          {/* Plataformas */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <Skeleton className="w-4 h-4 rounded-full" />
            <Skeleton className="w-4 h-4 rounded-full" />
            <Skeleton className="w-4 h-4 rounded-full" />
          </div>
          {/* Fecha (desktop) */}
          <Skeleton className="hidden sm:block w-14 h-3 flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ── Editar links de plataforma inline (sin ir a Ajustes > Sync) ───────────────
const LINK_CFG: Record<Platform, { label: string; Icon: (p: { active: boolean }) => JSX.Element; placeholder: string }> = {
  youtube:   { label: "YouTube",   Icon: YoutubeIcon,   placeholder: "https://youtube.com/shorts/..." },
  instagram: { label: "Instagram", Icon: InstagramIcon, placeholder: "https://instagram.com/reel/..." },
  tiktok:    { label: "TikTok",    Icon: TiktokIcon,    placeholder: "https://tiktok.com/@usuario/video/..." },
};

function EditLinksModal({ fileId, title, onClose, onPlatformsChange }: {
  fileId: string;
  title: string;
  onClose: () => void;
  onPlatformsChange: (platforms: Platform[]) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [links, setLinks] = useState<Record<Platform, string>>({ youtube: "", instagram: "", tiktok: "" });
  const [savingPlatform, setSavingPlatform] = useState<Platform | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Platform, string>>>({});
  const [saved, setSaved] = useState<Partial<Record<Platform, boolean>>>({});

  useEffect(() => {
    let cancelled = false;
    videoService.getPlatformLinks(fileId).then((data) => {
      if (cancelled) return;
      setLinks({ youtube: data.youtube ?? "", instagram: data.instagram ?? "", tiktok: data.tiktok ?? "" });
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fileId]);

  const handleSave = async (p: Platform) => {
    setSavingPlatform(p);
    setErrors((e) => ({ ...e, [p]: undefined }));
    try {
      const res = await videoService.setPlatformLink(fileId, p, links[p].trim() || null);
      setLinks((prev) => ({ ...prev, [p]: res.platform_url ?? "" }));
      onPlatformsChange(res.platforms);
      setSaved((s) => ({ ...s, [p]: true }));
      setTimeout(() => setSaved((s) => ({ ...s, [p]: false })), 2000);
    } catch (err: any) {
      setErrors((e) => ({ ...e, [p]: err.message || "Error al guardar" }));
    } finally {
      setSavingPlatform(null);
    }
  };

  return (
    <motion.div
      key="links-dialog"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-foreground font-semibold text-sm">Editar links de plataforma</h3>
            <p className="text-muted-foreground text-xs mt-1 truncate" title={title}>{title}</p>
          </div>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {ALL_PLATFORMS.map((p) => {
              const cfg = LINK_CFG[p];
              const Icon = cfg.Icon;
              return (
                <div key={p} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Icon active={!!links[p]} />
                    <span className="text-xs font-medium text-foreground">{cfg.label}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      value={links[p]}
                      onChange={(e) => setLinks((prev) => ({ ...prev, [p]: e.target.value }))}
                      placeholder={cfg.placeholder}
                      disabled={savingPlatform === p}
                      className="flex-1 bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary disabled:opacity-50"
                    />
                    <button
                      onClick={() => handleSave(p)}
                      disabled={savingPlatform !== null}
                      className="flex items-center gap-1 text-xs bg-primary/10 hover:bg-primary/20 text-primary px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {savingPlatform === p
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : saved[p] ? <Check className="w-3 h-3" /> : "Guardar"
                      }
                    </button>
                  </div>
                  {errors[p] && <p className="text-[11px] text-red-400">{errors[p]}</p>}
                </div>
              );
            })}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// ── Cache en memoria (sobrevive a montar/desmontar la vista, no a recargar la
// página) — mismo patrón que PublishingQueue: sin esto, cada vez que se cambia
// a esta pestaña se remonta el componente y se pierde todo, mostrando el
// spinner y esperando ~3s a la respuesta aunque la lista no haya cambiado.
type VideosCache = {
  page: number;
  tipo: TipoFilter;
  status: PubFilter | "";
  videos: DashboardVideo[];
  info: PaginationInfo | null;
};
let videosCache: VideosCache | null = null;

// ── Componente principal ──────────────────────────────────────────────────────
export function VideosView({
  role = "todopoderoso",
  autoOpenVideo,
  onAutoOpenConsumed,
}: {
  role?: string;
  autoOpenVideo?: { fileId: string; title: string } | null;
  onAutoOpenConsumed?: () => void;
}) {
  const [videos, setVideos]           = useState<DashboardVideo[]>(videosCache?.videos ?? []);
  const [info, setInfo]               = useState<PaginationInfo | null>(videosCache?.info ?? null);
  const [videosDir, setVideosDir]     = useState<string | null | undefined>(undefined); // undefined = cargando
  const [catalog, setCatalog]         = useState<any[] | null>(null);
  const [restoring, setRestoring]     = useState(false); // reintentando antes de asumir "otra máquina"
  const [currentPage, setCurrentPage] = useState(videosCache?.page ?? 1);
  const [loading, setLoading]         = useState(!videosCache);
  const [error, setError]             = useState<string | null>(null);

  // Badge "en la nube" — best-effort: en modo local (Electron/LAN) esta ruta
  // todavía no tiene proxy y falla en silencio, igual que backupService.getCloudStatus.
  const [syncStatus, setSyncStatus] = useState<Record<string, SyncStatusEntry>>({});
  useEffect(() => {
    const contentIds = videos.map(v => v.contentId).filter((id): id is string => !!id);
    if (contentIds.length === 0) return;
    backupService.getSyncStatus(contentIds)
      .then(d => setSyncStatus(prev => ({
        ...prev,
        ...Object.fromEntries(d.status.map(s => [s.contentId, s])),
      })))
      .catch(() => {});
  }, [videos]);

  const [showFilterPanel, setShowFilterPanel]     = useState(false);
  const [selectedTipo, setSelectedTipo]           = useState<TipoFilter>("");
  const [selectedStatus, setSelectedStatus]       = useState<PubFilter | "">("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);

  // Flujo de publicación elegido en el setup inicial: 'simple' colapsa las 3
  // plataformas en un solo estado; 'avanzado' (o null, instalaciones viejas) mantiene el detalle.
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode | null>(null);
  useEffect(() => {
    setupService.getWorkflowMode().then(d => setWorkflowMode(d.workflowMode)).catch(() => {});
  }, []);
  const isSimpleFlow = workflowMode === "simple";

  // Plataformas que el usuario eligió usar (Ajustes > Cuentas) — las que
  // desactivó no aparecen en los badges/filtros. Solo afecta qué se MUESTRA;
  // el flujo simple sigue agregando las 3 (no redefine "publicado completo").
  const [visiblePlatforms, setVisiblePlatforms] = useState<Platform[]>(ALL_PLATFORMS);
  useEffect(() => {
    setupService.getActivePlatforms()
      .then(d => setVisiblePlatforms(d.activePlatforms.length ? d.activePlatforms : ALL_PLATFORMS))
      .catch(() => {});
  }, []);

  // Selección
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds]     = useState<string[]>([]);
  const [bulkCycle, setBulkCycle] = useState<Record<Platform, PlatformState>>({
    youtube: "pendiente", instagram: "pendiente", tiktok: "pendiente",
  });
  const [simpleBulkState, setSimpleBulkState] = useState<PlatformState>("pendiente");
  const [bulkSaving, setBulkSaving] = useState(false);

  // Edición de título
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [savingId, setSavingId]   = useState<string | null>(null);
  const editInputRef              = useRef<HTMLInputElement>(null);

  // Borrar — diálogo de confirmación
  const [deleteTarget,  setDeleteTarget]  = useState<{ fileId: string; title: string } | null>(null);
  const [deletingId,    setDeletingId]    = useState<string | null>(null);
  const [deleteError,   setDeleteError]   = useState<string | null>(null);

  // Reproductor modal
  const [playerVideo, setPlayerVideo] = useState<{ fileId: string; title: string } | null>(null);

  // Editar links de plataforma — inline, sin ir a Ajustes > Sync
  const [linksTarget, setLinksTarget] = useState<{ fileId: string; title: string } | null>(null);

  // Abrir reproductor automáticamente cuando viene desde Calendario
  useEffect(() => {
    if (autoOpenVideo) {
      setPlayerVideo(autoOpenVideo);
      onAutoOpenConsumed?.();
    }
  }, [autoOpenVideo]);

  const LIMIT = 10;

  // ── Carga ──────────────────────────────────────────────────────────────────
  const loadPage = useCallback(
    async (page: number, tipo?: TipoFilter, status?: PubFilter | "") => {
      const tipoKey   = tipo   ?? "";
      const statusKey = status ?? "";
      // Si ya hay cache para esta misma página/filtros, se refresca en segundo
      // plano sin mostrar el spinner — la lista se actualiza sola si cambió algo.
      const hasMatchingCache = !!videosCache
        && videosCache.page === page && videosCache.tipo === tipoKey && videosCache.status === statusKey;
      if (!hasMatchingCache) setLoading(true);
      setError(null);
      try {
        const filters: { tipo?: string; content_status?: string } = {};
        if (tipo)   filters.tipo           = tipo;
        if (status) filters.content_status = status;
        const result = await videoService.getAllVideos(page, LIMIT, filters);
        setVideos(result.videos);
        setInfo(result.info);
        setCurrentPage(page);
        videosCache = { page, tipo: tipoKey, status: statusKey, videos: result.videos, info: result.info };
      } catch (err: any) {
        setError(err.message || "No se pudo conectar con el servidor.");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => { loadPage(1); }, [loadPage]);

  // Trae del backup en la nube los links de publicación (platform_videos) al
  // entrar a esta vista, para que "Editar links de plataforma" no muestre
  // datos viejos si algo se publicó desde otro dispositivo. Comparte el
  // cooldown de runSyncTick (syncOrchestrator.ts) con el resto de los
  // disparadores (mount de la app, foco recuperado, fallback periódico) — así
  // cambiar de pestaña seguido no golpea la central de más, pero si pasó un
  // rato sí refresca.
  useEffect(() => {
    runSyncTick().then(() => loadPage(currentPage, selectedTipo, selectedStatus));
  }, []);

  // Lee si hay carpeta configurada en esta máquina (señal de PC original)
  useEffect(() => {
    backupService.getLocalStatus()
      .then(s => setVideosDir(s.videosDir))
      .catch(() => setVideosDir(null));
  }, []);

  // Catálogo de solo lectura desde la nube: solo si NO hay carpeta configurada y SQLite vacío.
  // OJO: justo después de un wipe/login, App.tsx puede estar en medio de un
  // auto-detect + pull (reconstruyendo files/platforms/transcripts local) en paralelo.
  // Si asumimos "máquina distinta" con la primera foto vacía, esta vista queda
  // congelada mostrando el catálogo remoto aunque el auto-detect ya haya terminado
  // segundos después. Reintentamos unas veces antes de asumirlo definitivo.
  useEffect(() => {
    if (!info || videosDir === undefined) return;
    if (!(info.totalRecords === 0 && !videosDir)) {
      setCatalog(null);
      return;
    }

    let cancelled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const runRetryLoop = () => {
      let attempt = 0;
      const MAX_ATTEMPTS = 5;
      const RETRY_MS = 1500;

      setRestoring(true);

      const recheck = () => {
        if (cancelled) return;
        attempt++;
        Promise.all([
          backupService.getLocalStatus(),
          videoService.getAllVideos(1, LIMIT),
        ]).then(([status, result]) => {
          if (cancelled) return;
          if (status.videosDir || result.info.totalRecords > 0) {
            // El auto-detect ya terminó: esta sí es la máquina original.
            setVideosDir(status.videosDir);
            setVideos(result.videos);
            setInfo(result.info);
            setRestoring(false);
            return;
          }
          if (attempt < MAX_ATTEMPTS) {
            timeoutHandle = setTimeout(recheck, RETRY_MS);
          } else {
            // Después de reintentar, asumimos que de verdad es otra máquina.
            backupService.getCatalog()
              .then(d => { if (!cancelled) setCatalog(d.files ?? []); })
              .catch(() => { if (!cancelled) setCatalog([]); })
              .finally(() => { if (!cancelled) setRestoring(false); });
          }
        }).catch(() => {
          if (cancelled) return;
          if (attempt < MAX_ATTEMPTS) timeoutHandle = setTimeout(recheck, RETRY_MS);
          else setRestoring(false);
        });
      };

      timeoutHandle = setTimeout(recheck, RETRY_MS);
    };

    // Antes de meternos en el retry loop (~9s de "Restaurando…"), chequeamos UNA
    // vez si hay algo real que restaurar (carpeta o archivos en la nube). Para
    // una cuenta genuinamente nueva no hay nada — ni auto-detect ni pull corriendo
    // en paralelo — así que mostramos "sin videos" al toque en vez de hacerla
    // esperar los reintentos completos.
    backupService.getCatalog()
      .then(d => {
        if (cancelled) return;
        const hasSomethingToRestore = !!d.video_folder || (d.files?.length ?? 0) > 0;
        if (hasSomethingToRestore) runRetryLoop();
        else setCatalog([]);
      })
      .catch(() => {
        // Sin premium (o sin conexión): no hay backup posible, nada que restaurar.
        if (!cancelled) setCatalog([]);
      });

    return () => { cancelled = true; if (timeoutHandle) clearTimeout(timeoutHandle); };
  }, [info, videosDir]);

  useEffect(() => {
    if (!deleteTarget) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") { setDeleteTarget(null); setDeleteError(null); } };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteTarget]);

  const applyFilters = (tipo: TipoFilter, status: PubFilter | "") => {
    setSelectedTipo(tipo);
    setSelectedStatus(status);
    loadPage(1, tipo, status);
  };

  const togglePlatform = (p: string) =>
    setSelectedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );

  const cancelSelection = () => { setSelectionMode(false); setSelectedIds([]); };

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  // ── Acciones masivas ───────────────────────────────────────────────────────
  const applyBulkPlatforms = async (ps: Platform[], next: PlatformState) => {
    if (selectedIds.length === 0 || bulkSaving) return;

    const prevVideos = videos;
    setVideos((prev) => prev.map((v) => {
      if (!selectedIds.includes(v._id)) return v;
      let newPlatforms = v.platforms.filter((x) => !ps.includes(x));
      let newDiscarded = v.platforms_discarded.filter((x) => !ps.includes(x));
      if (next === "publicado") newPlatforms = [...newPlatforms, ...ps];
      else if (next === "descartado") newDiscarded = [...newDiscarded, ...ps];
      return { ...v, platforms: newPlatforms, platforms_discarded: newDiscarded };
    }));

    setBulkSaving(true);
    try {
      await videoService.updateVideosBulk(selectedIds, { platforms: ps, platformState: next });
    } catch {
      setVideos(prevVideos);
    } finally {
      setBulkSaving(false);
    }
  };

  const applyBulkPlatform = (p: Platform) => {
    const next = nextPlatformState(bulkCycle[p]);
    setBulkCycle((prev) => ({ ...prev, [p]: next }));
    applyBulkPlatforms([p], next);
  };

  const applyBulkSimple = () => {
    const next = nextPlatformState(simpleBulkState);
    setSimpleBulkState(next);
    applyBulkPlatforms(ALL_PLATFORMS, next);
  };

  const applyBulkTipo = async (tipo: TipoFilter) => {
    if (selectedIds.length === 0 || !tipo || bulkSaving) return;
    setBulkSaving(true);
    try {
      await videoService.updateVideosBulk(selectedIds, { tipo_contenido: tipo });
      await loadPage(currentPage, selectedTipo, selectedStatus);
    } finally {
      setBulkSaving(false);
    }
  };

  // La miniatura resuelve (y persiste) la duración real la primera vez que se
  // pide — esto corrige la fila en el momento en vez de esperar a recargar
  // toda la lista de Videos.
  const applyProbedDuration = (fileId: string, sec: number) => {
    setVideos((prev) => prev.map((v) =>
      v.fileId === fileId && v.duration === "—" ? { ...v, duration: formatDurationFromSeconds(sec) } : v
    ));
  };

  // Mismo mecanismo para el aspecto real: sin esto, un reel (9:16) recién
  // agregado quedaba clasificado "16:9" por default (sin formato/resolución
  // todavía) y el container de la miniatura nunca usaba la caja vertical.
  const applyProbedResolution = (fileId: string, resolucion: string) => {
    const ratio = deriveRatio(undefined, resolucion);
    setVideos((prev) => prev.map((v) =>
      v.fileId === fileId && v.ratio !== ratio ? { ...v, ratio } : v
    ));
  };

  // ── Filtro de plataforma client-side ──────────────────────────────────────
  const displayedVideos =
    selectedPlatforms.length === 0
      ? videos
      : videos.filter((v) => {
          const isVertical = v.ratio === "9:16";
          return selectedPlatforms.some((p) =>
            p === "youtube" ? !isVertical : isVertical
          );
        });

  // ── Rename ─────────────────────────────────────────────────────────────────
  const startEdit = (video: DashboardVideo) => {
    setEditingId(video._id);
    setEditTitle(video.title);
    setTimeout(() => editInputRef.current?.select(), 50);
  };

  const cancelEdit = () => { setEditingId(null); setEditTitle(""); };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { fileId } = deleteTarget;
    setDeletingId(fileId);
    setDeleteError(null);
    try {
      await videoService.deleteFile(fileId);
      setVideos(prev => prev.filter(v => v.fileId !== fileId));
      setDeleteTarget(null);
    } catch (err: any) {
      setDeleteError(err?.message || "Error al eliminar. Intenta de nuevo.");
    } finally {
      setDeletingId(null);
    }
  };

  const saveEdit = async (video: DashboardVideo) => {
    if (!editTitle.trim() || editTitle.trim() === video.title) { cancelEdit(); return; }
    if (!video.fileId) { alert("fileId no disponible."); return; }
    setSavingId(video._id);
    try {
      await videoService.renameVideo(video.fileId, editTitle.trim());
      setVideos((prev) =>
        prev.map((v) => v._id === video._id ? { ...v, title: editTitle.trim() } : v)
      );
      cancelEdit();
    } catch (err: any) {
      alert("Error al renombrar: " + err.message);
    } finally {
      setSavingId(null);
    }
  };

  const totalPages        = info?.totalPages ?? 1;
  const hasActiveFilters  = selectedTipo !== "" || selectedStatus !== "" || selectedPlatforms.length > 0;
  const activeFilterCount = (selectedTipo ? 1 : 0) + (selectedStatus ? 1 : 0) + selectedPlatforms.length;

  // ── Reintentando antes de decidir si es "otra máquina" ───────────────────────
  if (restoring) {
    return (
      <motion.div
        key="restoring"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="flex flex-col items-center justify-center gap-4 py-20 text-center"
      >
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}
          className="w-10 h-10 rounded-full border-2 border-primary/20 border-t-primary"
        />
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <p className="text-foreground font-medium text-sm">Restaurando tu catálogo…</p>
          <p className="text-muted-foreground text-xs mt-1">Buscando tus videos y sincronizando con la nube</p>
        </motion.div>
      </motion.div>
    );
  }

  // ── Máquina no original: catálogo de solo lectura desde la nube ──────────────
  if (!loading && videosDir === null && (info?.totalRecords ?? 0) === 0 && catalog && catalog.length > 0) {
    const fmtDur = (s?: number | null) =>
      s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "";
    return (
      <motion.div
        key="cloud-catalog"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="space-y-4">
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200/90 text-sm">
          <MonitorOff className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-400" />
          <div>
            <p className="font-medium">Esta no es tu máquina original</p>
            <p className="text-xs text-amber-200/70 mt-0.5">
              Mostrando tu catálogo desde la nube (solo nombres). Los archivos de video están en tu PC principal,
              así que aquí no se pueden reproducir, editar ni publicar.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <h2 className="text-foreground font-semibold text-lg">Catálogo</h2>
          <p className="text-muted-foreground text-xs font-mono">{catalog.length} videos</p>
        </div>

        <div className="space-y-2">
          {catalog.map((f, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 20) * 0.02 }}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-card border border-border"
            >
              <Film className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground truncate">{f.file_name}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {f.content_status && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground capitalize">
                      {f.content_status}
                    </span>
                  )}
                  {(f.platforms ?? []).map((p: string) => (
                    <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary capitalize">
                      {p}
                    </span>
                  ))}
                  {f.scheduled_date && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground flex items-center gap-1">
                      <CalendarClock className="w-2.5 h-2.5" />
                      {new Date(f.scheduled_date).toLocaleDateString()}
                    </span>
                  )}
                  {fmtDur(f.duracion_segundos) && (
                    <span className="text-[10px] text-muted-foreground/60 font-mono">{fmtDur(f.duracion_segundos)}</span>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      key="videos-view"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      className="space-y-4"
    >

      {/* ── Cabecera ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-foreground font-semibold text-lg">Todos los videos</h2>
          {info && (
            <p className="text-muted-foreground text-xs mt-0.5 font-mono">
              {info.totalRecords} registros · página {info.currentPage}/{info.totalPages}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <AnimatePresence mode="wait" initial={false}>
            {role === "todopoderoso" && selectionMode ? (
              <motion.button
                key="cancel"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.15 }}
                onClick={cancelSelection}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                <X className="w-3.5 h-3.5" /> Cancelar
              </motion.button>
            ) : role === "todopoderoso" ? (
              <motion.button
                key="select"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.15 }}
                onClick={() => setSelectionMode(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-border bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
              >
                Seleccionar
              </motion.button>
            ) : null}
          </AnimatePresence>

          <button
            onClick={() => setShowFilterPanel((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
              showFilterPanel || hasActiveFilters
                ? "bg-primary/20 text-primary border-primary/40 font-semibold"
                : "bg-secondary text-foreground hover:bg-secondary/80 border-border"
            }`}
          >
            <ListFilter className="w-3.5 h-3.5" />
            Filtros{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
        </div>
      </div>

      {/* ── Barra de acciones masivas ─────────────────────────────────────── */}
      <AnimatePresence initial={false}>
      {selectionMode && selectedIds.length > 0 && (
        <motion.div
          key="bulk-toolbar"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{ overflow: "hidden" }}
        >
          <div className="bg-primary/5 border border-primary/30 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
            <span className="text-xs text-foreground font-medium flex-shrink-0">
              {selectedIds.length} seleccionado{selectedIds.length === 1 ? "" : "s"}
            </span>

            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {isSimpleFlow ? "Estado" : "Plataforma"}
                </span>
                {isSimpleFlow ? (
                  <SimpleStatusBadge state={simpleBulkState} onClick={applyBulkSimple} />
                ) : (
                  visiblePlatforms.map((p) => (
                    <PlatformBadge key={p} platform={p} state={bulkCycle[p]} onClick={() => applyBulkPlatform(p)} />
                  ))
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Tipo</span>
                <select
                  onChange={(e) => { applyBulkTipo(e.target.value as TipoFilter); e.target.value = ""; }}
                  defaultValue=""
                  disabled={bulkSaving}
                  className="bg-secondary border border-border rounded-lg px-2 py-1 text-xs text-foreground disabled:opacity-50"
                >
                  <option value="" disabled>Asignar…</option>
                  <option value="GUION_ESTRUCTURADO">Guión</option>
                  <option value="CLIP_RANDOM">Random</option>
                  <option value="CLIP_SIN_VOZ">Sin Voz</option>
                </select>
              </div>

              {bulkSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* ── Panel de filtros ──────────────────────────────────────────────── */}
      <AnimatePresence initial={false}>
      {showFilterPanel && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          style={{ overflow: "hidden" }}
        >
        <div className="bg-card/40 border border-border rounded-xl p-4 space-y-3">
          {/* Plataforma */}
          <div className="space-y-1.5 sm:space-y-0 sm:flex sm:items-center sm:gap-4">
            <span className="block text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sm:w-20 sm:flex-shrink-0">Plataforma</span>
            <div className="flex gap-2 flex-wrap">
              {visiblePlatforms.map((p) => (
                <Chip key={p} active={selectedPlatforms.includes(p)} onClick={() => togglePlatform(p)}>{p.charAt(0).toUpperCase() + p.slice(1)}</Chip>
              ))}
            </div>
          </div>

          {/* Estado de publicación (derivado de platforms[]) */}
          <div className="space-y-1.5 sm:space-y-0 sm:flex sm:items-center sm:gap-4">
            <span className="block text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sm:w-20 sm:flex-shrink-0">Estado</span>
            <div className="flex gap-2 flex-wrap">
              {(["sin_publicar", "parcial", "completo"] as PubFilter[]).map((s) => (
                <Chip key={s} active={selectedStatus === s} onClick={() => applyFilters(selectedTipo, selectedStatus === s ? "" : s)}>{PUB_FILTER_LABELS[s]}</Chip>
              ))}
            </div>
          </div>

          {/* Tipo */}
          <div className="space-y-1.5 sm:space-y-0 sm:flex sm:items-center sm:gap-4">
            <span className="block text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sm:w-20 sm:flex-shrink-0">Tipo</span>
            <div className="flex gap-2 flex-wrap">
              {([["GUION_ESTRUCTURADO", "Guión"] as [TipoFilter, string], ["CLIP_RANDOM", "Random"] as [TipoFilter, string], ["CLIP_SIN_VOZ", "Sin Voz"] as [TipoFilter, string]]).map(([val, label]) => (
                <Chip key={val} active={selectedTipo === val} onClick={() => applyFilters(selectedTipo === val ? "" : val, selectedStatus)}>{label}</Chip>
              ))}
            </div>
          </div>

          {/* Limpiar */}
          {hasActiveFilters && (
            <div className="pt-1 border-t border-border/40">
              <button
                onClick={() => { setSelectedPlatforms([]); applyFilters("", ""); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Limpiar filtros
              </button>
            </div>
          )}
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* ── Error ─────────────────────────────────────────────────────────── */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* ── Contenido principal (skeleton → lista) ────────────────────────── */}
      <AnimatePresence mode="wait">

        {loading && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <VideoListSkeleton rows={LIMIT} />
          </motion.div>
        )}

        {!loading && displayedVideos.length === 0 && !error && (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="bg-card border border-border rounded-xl p-10 text-center text-muted-foreground text-sm"
          >
            No hay videos que coincidan con los filtros activos.
          </motion.div>
        )}

        {!loading && displayedVideos.length > 0 && (
          <motion.div
            key="content"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="bg-card border border-border rounded-xl divide-y divide-border"
          >
          {displayedVideos.map((video, idx) => {
            const isFirst   = idx === 0;
            const isLast    = idx === displayedVideos.length - 1;
            const globalIdx = (currentPage - 1) * LIMIT + idx + 1;
            const isEditing = editingId === video._id;
            const isSaving  = savingId  === video._id;
            const isSelected = selectedIds.includes(video._id);

            return (
              <motion.div
                key={video._id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.04, duration: 0.22, ease: "easeOut" }}
                className={`flex items-center gap-3 px-4 py-3 hover:bg-secondary/40 transition-colors
                  ${isFirst ? "rounded-t-xl" : ""}
                  ${isLast  ? "rounded-b-xl" : ""}
                  ${isSelected ? "bg-primary/5" : ""}
                `}
              >
                {/* Checkbox selección */}
                {selectionMode && (
                  <button
                    onClick={() => toggleSelect(video._id)}
                    className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      isSelected ? "bg-primary border-primary" : "border-border hover:border-primary/60"
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                  </button>
                )}

                {/* Número — oculto en móvil */}
                <span className="hidden sm:block text-muted-foreground text-sm w-6 flex-shrink-0 text-right font-mono">
                  {String(globalIdx).padStart(2, "0")}
                </span>

                {/* Miniatura — mismo tamaño fijo que usa Taller.tsx para esta misma fila,
                    el ratio ya se ve aparte en el chip 9:16/16:9 junto al título */}
                <button
                  onClick={() => video.fileId && setPlayerVideo({ fileId: video.fileId, title: video.title })}
                  disabled={!video.fileId}
                  className="relative w-20 h-12 sm:w-24 sm:h-14 rounded-lg overflow-hidden bg-secondary flex-shrink-0 flex items-center justify-center border border-border hover:border-primary/50 hover:brightness-110 transition-all disabled:cursor-not-allowed"
                >
                  <VideoThumb
                    fileId={video.fileId}
                    onDuration={(sec) => video.fileId && applyProbedDuration(video.fileId, sec)}
                    onResolution={(res) => video.fileId && applyProbedResolution(video.fileId, res)}
                  />
                  {video.duration && video.duration !== "0:00" && video.duration !== "—" && (
                    <span className="absolute bottom-1 right-1 bg-black/80 text-white text-[10px] px-1 rounded leading-tight font-mono">
                      {video.duration}
                    </span>
                  )}
                </button>

                {/* Título editable + metadata ── */}
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        ref={editInputRef}
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter")  saveEdit(video);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        disabled={isSaving}
                        className="flex-1 bg-secondary border border-primary/40 rounded px-2 py-0.5 text-sm text-foreground focus:outline-none focus:border-primary"
                        autoFocus
                      />
                      <button onClick={() => saveEdit(video)} disabled={isSaving}
                        className="p-1 text-emerald-400 hover:text-emerald-300 transition-colors" title="Guardar">
                        <Check className="w-4 h-4" />
                      </button>
                      <button onClick={cancelEdit} disabled={isSaving}
                        className="p-1 text-muted-foreground hover:text-foreground transition-colors" title="Cancelar">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start gap-1.5 min-w-0 group">
                      <button
                        onClick={() => video.fileId && setPlayerVideo({ fileId: video.fileId, title: video.title })}
                        disabled={!video.fileId}
                        className="text-foreground text-sm font-medium truncate hover:text-primary transition-colors text-left disabled:cursor-default leading-snug"
                      >
                        {video.title}
                      </button>
                      {role === "todopoderoso" && (
                        <>
                          <button
                            onClick={() => startEdit(video)}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground transition-all flex-shrink-0 mt-px"
                            title="Renombrar"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => video.fileId && setDeleteTarget({ fileId: video.fileId, title: video.title })}
                            disabled={deletingId === video.fileId}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-red-500 transition-all flex-shrink-0 mt-px"
                            title="Eliminar archivo"
                          >
                            {deletingId === video.fileId
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <Trash2 className="w-3 h-3" />
                            }
                          </button>
                          <button
                            onClick={() => video.fileId && setLinksTarget({ fileId: video.fileId, title: video.title })}
                            disabled={!video.fileId}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-primary transition-all flex-shrink-0 mt-px"
                            title="Editar links de plataforma"
                          >
                            <Link2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {/* Segunda línea: tipo + ratio + fecha (móvil muestra fecha aquí) */}
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-muted-foreground text-xs">{video.tipoLabel}</span>
                    <span className="text-[10px] border border-border rounded px-1 py-0.5 text-muted-foreground font-mono">
                      {video.ratio}
                    </span>
                    {/* Nube = bytes reales en Biblioteca remota. Backup de metadata es
                        otra cosa (backup_files, casi todo el catálogo) -- separados para
                        no hacer creer que "está en la nube" cuando solo es el catálogo. */}
                    {video.contentId && syncStatus[video.contentId]?.inRemoteLibrary && (
                      <span title="Video en la Biblioteca remota (Nube)" className="text-emerald-400/80">
                        <Cloud className="w-3 h-3" />
                      </span>
                    )}
                    {video.contentId && syncStatus[video.contentId]?.metadataBackedUp && (
                      <span title="Metadata respaldada en la nube" className="text-muted-foreground/60">
                        <Database className="w-3 h-3" />
                      </span>
                    )}
                    {/* Fecha visible sólo en móvil aquí */}
                    <span className="sm:hidden text-muted-foreground text-[10px] font-mono">
                      {video.uploadedAt}
                    </span>
                  </div>
                </div>

                {/* Plataformas: flujo simple = un estado agregado, avanzado = 3 independientes */}
                <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
                  {isSimpleFlow ? (
                    <SimpleStatusBadge
                      state={aggregatePlatformState(video)}
                      onClick={role !== "todopoderoso" ? undefined : async () => {
                        if (!video.fileId) return;
                        const next = nextPlatformState(aggregatePlatformState(video));
                        const newPlatforms = next === "publicado" ? [...ALL_PLATFORMS] : [];
                        const newDiscarded = next === "descartado" ? [...ALL_PLATFORMS] : [];
                        setVideos(prev => prev.map(v =>
                          v.fileId === video.fileId
                            ? { ...v, platforms: newPlatforms, platforms_discarded: newDiscarded }
                            : v
                        ));
                        try {
                          await videoService.updateVideoPlatforms(video.fileId, newPlatforms, newDiscarded);
                        } catch {
                          setVideos(prev => prev.map(v =>
                            v.fileId === video.fileId
                              ? { ...v, platforms: video.platforms, platforms_discarded: video.platforms_discarded }
                              : v
                          ));
                        }
                      }}
                    />
                  ) : (
                    visiblePlatforms.map((p) => {
                      const state: PlatformState = video.platforms.includes(p)
                        ? "publicado"
                        : video.platforms_discarded.includes(p)
                        ? "descartado"
                        : "pendiente";

                      if (role !== "todopoderoso") {
                        return <PlatformBadge key={p} platform={p} state={state} />;
                      }

                      return (
                        <PlatformBadge
                          key={p}
                          platform={p}
                          state={state}
                          onClick={async () => {
                            if (!video.fileId) return;
                            // Ciclo: pendiente → publicado → descartado → pendiente
                            let newPlatforms = [...video.platforms];
                            let newDiscarded = [...video.platforms_discarded];
                            if (state === "pendiente") {
                              newPlatforms = [...newPlatforms.filter(x => x !== p), p];
                              newDiscarded = newDiscarded.filter(x => x !== p);
                            } else if (state === "publicado") {
                              newPlatforms = newPlatforms.filter(x => x !== p);
                              newDiscarded = [...newDiscarded.filter(x => x !== p), p];
                            } else {
                              newPlatforms = newPlatforms.filter(x => x !== p);
                              newDiscarded = newDiscarded.filter(x => x !== p);
                            }
                            setVideos(prev => prev.map(v =>
                              v.fileId === video.fileId
                                ? { ...v, platforms: newPlatforms, platforms_discarded: newDiscarded }
                                : v
                            ));
                            try {
                              await videoService.updateVideoPlatforms(video.fileId, newPlatforms, newDiscarded);
                            } catch {
                              setVideos(prev => prev.map(v =>
                                v.fileId === video.fileId
                                  ? { ...v, platforms: video.platforms, platforms_discarded: video.platforms_discarded }
                                  : v
                              ));
                            }
                          }}
                        />
                      );
                    })
                  )}
                </div>

                {/* Métricas — solo desktop */}
                <div className="hidden lg:flex items-center gap-6 text-sm flex-shrink-0">
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Eye className="w-3.5 h-3.5" />--
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <ThumbsUp className="w-3.5 h-3.5" />--
                  </span>
                </div>

                {/* Fecha — solo sm+ */}
                <span className="hidden sm:block text-muted-foreground text-xs flex-shrink-0 font-mono">
                  {video.uploadedAt}
                </span>
              </motion.div>
            );
          })}
          </motion.div>
        )}

      </AnimatePresence>

      {/* ── Modal reproductor ─────────────────────────────────────────────── */}
      {playerVideo && (
        <VideoModal
          fileId={playerVideo.fileId}
          title={playerVideo.title}
          onClose={() => setPlayerVideo(null)}
        />
      )}

      {/* ── Editar links de plataforma ─────────────────────────────────────── */}
      <AnimatePresence>
      {linksTarget && (
        <EditLinksModal
          fileId={linksTarget.fileId}
          title={linksTarget.title}
          onClose={() => setLinksTarget(null)}
          onPlatformsChange={(platforms) => {
            setVideos((prev) => prev.map((v) =>
              v.fileId === linksTarget.fileId ? { ...v, platforms } : v
            ));
          }}
        />
      )}
      </AnimatePresence>

      {/* ── Diálogo confirmar eliminación ─────────────────────────────────── */}
      <AnimatePresence>
      {deleteTarget && (
        <motion.div
          key="delete-dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) { setDeleteTarget(null); setDeleteError(null); } }}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-4 h-4 text-red-500" />
              </div>
              <div>
                <h3 className="text-foreground font-semibold text-sm">Eliminar video</h3>
                <p className="text-muted-foreground text-xs mt-1 leading-snug">
                  Se eliminará el archivo físico y su transcripción. Esta acción no se puede deshacer.
                </p>
              </div>
            </div>

            <div className="bg-secondary/60 border border-border rounded-lg px-3 py-2">
              <p className="text-foreground text-xs font-medium truncate">{deleteTarget.title}</p>
            </div>

            {deleteError && (
              <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {deleteError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
                disabled={!!deletingId}
                className="px-4 py-2 rounded-lg text-sm border border-border bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={confirmDelete}
                disabled={!!deletingId}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 hover:bg-red-500 text-white font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {deletingId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Eliminar
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* ── Paginación ────────────────────────────────────────────────────── */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => loadPage(currentPage - 1, selectedTipo, selectedStatus)}
            disabled={currentPage <= 1}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Anterior
          </button>

          <div className="flex items-center gap-1">
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => Math.abs(p - currentPage) <= 2 || p === 1 || p === totalPages)
              .reduce<(number | "...")[]>((acc, p, i, arr) => {
                if (i > 0 && (p - (arr[i - 1] as number)) > 1) acc.push("...");
                acc.push(p);
                return acc;
              }, [])
              .map((item, i) =>
                item === "..." ? (
                  <span key={`e-${i}`} className="px-2 text-muted-foreground text-sm">…</span>
                ) : (
                  <button
                    key={item}
                    onClick={() => loadPage(item as number, selectedTipo, selectedStatus)}
                    className={`w-8 h-8 rounded-lg text-sm transition-colors ${
                      item === currentPage
                        ? "bg-primary text-primary-foreground"
                        : "border border-border hover:bg-secondary text-muted-foreground"
                    }`}
                  >
                    {item}
                  </button>
                )
              )}
          </div>

          <button
            onClick={() => loadPage(currentPage + 1, selectedTipo, selectedStatus)}
            disabled={currentPage >= totalPages}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Siguiente
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </motion.div>
  );
}
