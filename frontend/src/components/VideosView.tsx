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
} from "lucide-react";
import { videoService, DashboardVideo, PaginationInfo, VideoContentStatus } from "../services/api";
import { VideoModal } from "./player/VideoModal";

// ── Tipos ─────────────────────────────────────────────────────────────────────
type TipoFilter = "" | "GUION_ESTRUCTURADO" | "CLIP_RANDOM" | "CLIP_SIN_VOZ";

// ── Labels de estado (para chips de filtro) ──────────────────────────────────
const STATUS_CONFIG: Record<VideoContentStatus, { label: string }> = {
  publicado:  { label: "Publicado"  },
  borrador:   { label: "Borrador"   },
  procesando: { label: "Procesando" },
  descartado: { label: "Descartado" },
};


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

// ── Chip de filtro ────────────────────────────────────────────────────────────
function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs border transition-colors ${
        active
          ? "bg-primary/20 text-primary border-primary/50 font-semibold"
          : "bg-secondary/40 text-muted-foreground border-border hover:text-foreground hover:bg-secondary/70"
      }`}
    >
      {label}
    </button>
  );
}


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
  const [videos, setVideos]           = useState<DashboardVideo[]>([]);
  const [info, setInfo]               = useState<PaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);

  // Filtros
  const [showFilterPanel, setShowFilterPanel]     = useState(false);
  const [selectedTipo, setSelectedTipo]           = useState<TipoFilter>("");
  const [selectedStatus, setSelectedStatus]       = useState<VideoContentStatus | "">("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);

  // Selección
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds]     = useState<string[]>([]);

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
    async (page: number, tipo?: TipoFilter, status?: VideoContentStatus | "") => {
      setLoading(true);
      setError(null);
      try {
        const filters: { tipo?: string; content_status?: string } = {};
        if (tipo)   filters.tipo           = tipo;
        if (status) filters.content_status = status;
        const result = await videoService.getAllVideos(page, LIMIT, filters);
        setVideos(result.videos);
        setInfo(result.info);
        setCurrentPage(page);
      } catch (err: any) {
        setError(err.message || "No se pudo conectar con el servidor.");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => { loadPage(1); }, [loadPage]);

  useEffect(() => {
    if (!deleteTarget) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") { setDeleteTarget(null); setDeleteError(null); } };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteTarget]);

  const applyFilters = (tipo: TipoFilter, status: VideoContentStatus | "") => {
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

  return (
    <div className="space-y-4">

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
              {["youtube", "instagram", "tiktok"].map((p) => (
                <FilterChip key={p} label={p.charAt(0).toUpperCase() + p.slice(1)} active={selectedPlatforms.includes(p)} onClick={() => togglePlatform(p)} />
              ))}
            </div>
          </div>

          {/* Estado */}
          <div className="space-y-1.5 sm:space-y-0 sm:flex sm:items-center sm:gap-4">
            <span className="block text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sm:w-20 sm:flex-shrink-0">Estado</span>
            <div className="flex gap-2 flex-wrap">
              {(["publicado", "borrador", "procesando", "descartado"] as VideoContentStatus[]).map((s) => (
                <FilterChip key={s} label={STATUS_CONFIG[s].label} active={selectedStatus === s} onClick={() => applyFilters(selectedTipo, selectedStatus === s ? "" : s)} />
              ))}
            </div>
          </div>

          {/* Tipo */}
          <div className="space-y-1.5 sm:space-y-0 sm:flex sm:items-center sm:gap-4">
            <span className="block text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sm:w-20 sm:flex-shrink-0">Tipo</span>
            <div className="flex gap-2 flex-wrap">
              {([["GUION_ESTRUCTURADO", "Guión"] as [TipoFilter, string], ["CLIP_RANDOM", "Random"] as [TipoFilter, string], ["CLIP_SIN_VOZ", "Sin Voz"] as [TipoFilter, string]]).map(([val, label]) => (
                <FilterChip key={val} label={label} active={selectedTipo === val} onClick={() => applyFilters(selectedTipo === val ? "" : val, selectedStatus)} />
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
            className="flex flex-col items-center justify-center py-16 gap-4"
          >
            <div className="relative w-10 h-10">
              <motion.span
                className="absolute inset-0 rounded-full border-2 border-primary/30"
                style={{ borderTopColor: "var(--primary)" }}
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
              />
            </div>
            <p className="text-muted-foreground text-sm">Cargando videos...</p>
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

                {/* Miniatura */}
                <button
                  onClick={() => video.fileId && setPlayerVideo({ fileId: video.fileId, title: video.title })}
                  disabled={!video.fileId}
                  className="relative w-20 h-12 sm:w-24 sm:h-14 rounded-lg overflow-hidden bg-secondary flex-shrink-0 flex items-center justify-center border border-border hover:border-primary/50 hover:brightness-110 transition-all disabled:cursor-not-allowed"
                >
                  <Film className="w-5 h-5 text-muted-foreground/40" />
                  {video.duration && video.duration !== "0:00" && (
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
                    {/* Fecha visible sólo en móvil aquí */}
                    <span className="sm:hidden text-muted-foreground text-[10px] font-mono">
                      {video.uploadedAt}
                    </span>
                  </div>
                </div>

                {/* Plataformas */}
                <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
                  {(["youtube", "instagram", "tiktok"] as const).map((p) => {
                    const active = video.platforms.includes(p);
                    const Icon = p === "youtube" ? YoutubeIcon : p === "instagram" ? InstagramIcon : TiktokIcon;
                    if (role !== "todopoderoso") return <Icon key={p} active={active} />;
                    return (
                      <button
                        key={p}
                        title={`${p} · ${active ? "Publicado" : "No publicado"}`}
                        onClick={async () => {
                          if (!video.fileId) return;
                          const next = active
                            ? video.platforms.filter((x) => x !== p)
                            : [...video.platforms, p];
                          // Optimista: actualizamos el array local
                          setVideos(prev => prev.map(v =>
                            v.fileId === video.fileId ? { ...v, platforms: next } : v
                          ));
                          try {
                            await videoService.updateVideoPlatforms(video.fileId, next);
                          } catch {
                            // Revertimos si falla
                            setVideos(prev => prev.map(v =>
                              v.fileId === video.fileId ? { ...v, platforms: video.platforms } : v
                            ));
                          }
                        }}
                        className="transition-transform hover:scale-110 active:scale-95"
                      >
                        <Icon active={active} />
                      </button>
                    );
                  })}
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
    </div>
  );
}
