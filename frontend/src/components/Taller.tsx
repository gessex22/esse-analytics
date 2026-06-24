import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronDown,
  ChevronRight,
  Trash2,
  Check,
  ListFilter,
  AlertCircle,
  X,
} from "lucide-react";
import { videoService, IdeaCollection, IdeaStatus } from "../services/api";
import { useTranscripStatus, TranscripRequired } from "./TranscripGate";

// ── Configuración visual por estado ──────────────────────────────────────────
const STATUS_CONFIG: Record<IdeaStatus, { label: string; chipClass: string }> = {
  publicado:  { label: "Publicado",  chipClass: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
  borrador:   { label: "Borrador",   chipClass: "text-amber-400  bg-amber-500/10  border-amber-500/30"  },
  procesando: { label: "Procesando", chipClass: "text-blue-400   bg-blue-500/10   border-blue-500/30"   },
  descartado: { label: "Descartado", chipClass: "text-red-400    bg-red-500/10    border-red-500/30"    },
};

type VersionFilter = "all" | "only-originals" | "with-versions";

// ── Chip reutilizable ─────────────────────────────────────────────────────────
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
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
export function Taller({ role = "todopoderoso" }: { role?: string }) {
  const [ideas, setIdeas] = useState<IdeaCollection[]>([]);
  const [expandedItems, setExpandedItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 8;

  // Detección del componente de transcripción (el Taller depende de él)
  const { status: transcrip, loading: transcripLoading } = useTranscripStatus();

  // Filtros
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [versionFilter, setVersionFilter] = useState<VersionFilter>("all");

  // Selección
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Dropdown de estado por idea
  const [openStatusId, setOpenStatusId] = useState<string | null>(null);

  // ── Carga de datos ──────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await videoService.getTallerIdeas();
      setIdeas(data);
    } catch (err: any) {
      setError(err.message || "Error al conectar con el taller.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const toggleChip = (arr: string[], setter: (v: string[]) => void, value: string) => {
    setter(arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]);
  };

  const toggleVersionFilter = (val: VersionFilter) => {
    setVersionFilter((prev) => (prev === val ? "all" : val));
  };

  const toggleExpand = (id: string) =>
    setExpandedItems((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const cancelSelection = () => {
    setSelectionMode(false);
    setSelectedIds([]);
  };

  // ── Handlers de API ─────────────────────────────────────────────────────────
  const handleStatusChange = async (ideaId: string, newStatus: IdeaStatus) => {
    setOpenStatusId(null);
    try {
      await videoService.updateIdeaStatus(ideaId, newStatus);
      await fetchData();
    } catch (err: any) {
      alert("Error al cambiar el estado: " + err.message);
    }
  };

  const handleSetMain = async (ideaId: string, versionId: string) => {
    try {
      await videoService.setMainVersion(ideaId, versionId);
      await fetchData();
    } catch (err: any) {
      alert("No se pudo cambiar la versión principal: " + err.message);
    }
  };

  const handleDeleteVideo = async (
    ideaId: string,
    videoId: string,
    title: string
  ) => {
    if (!window.confirm(`¿Eliminar "${title}" y su transcripción?`)) return;
    try {
      await videoService.deleteVideoIndividual(ideaId, videoId);
      await fetchData();
    } catch (err: any) {
      alert("Error al eliminar: " + err.message);
    }
  };

  const handleDeleteIdea = async (ideaId: string, title: string) => {
    if (
      !window.confirm(
        `¿Eliminar la idea "${title}" y todo su contenido asociado?\n\nEsta acción es permanente.`
      )
    )
      return;
    try {
      await videoService.deleteIdeaCentral(ideaId);
      await fetchData();
    } catch (err: any) {
      alert("Error al eliminar: " + err.message);
    }
  };

  // ── Filtrado ────────────────────────────────────────────────────────────────
  const filteredIdeas = ideas.filter((idea) => {
    const vp = idea.videosOriginales[0];
    const principal = vp?.versions.find((v) => v.isMain);
    const altCount = vp?.versions.filter((v) => !v.isMain).length ?? 0;

    // Plataforma → derivar del ratio del video principal
    if (selectedPlatforms.length > 0) {
      const ratio = principal?.ratio ?? vp?.ratio;
      const isVertical = ratio === "9:16";
      const match = selectedPlatforms.some((p) => {
        if (p === "youtube") return !isVertical;
        return isVertical; // instagram / tiktok
      });
      if (!match) return false;
    }

    // Estado de la idea
    if (selectedStatuses.length > 0) {
      const s = idea.status ?? "borrador";
      if (!selectedStatuses.includes(s)) return false;
    }

    // Versiones
    if (versionFilter === "only-originals" && altCount > 0) return false;
    if (versionFilter === "with-versions" && altCount === 0) return false;

    return true;
  });

  // ── Paginación ──────────────────────────────────────────────────────────────
  const totalItems = filteredIdeas.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  const indexOfLastItem = currentPage * ITEMS_PER_PAGE;
  const indexOfFirstItem = indexOfLastItem - ITEMS_PER_PAGE;
  const currentIdeas = filteredIdeas.slice(indexOfFirstItem, indexOfLastItem);

  // ── Contadores (sobre ideas sin filtrar) ────────────────────────────────────
  const totalOriginales = ideas.length;
  const totalVersiones = ideas.reduce(
    (acc, idea) =>
      acc + (idea.videosOriginales[0]?.versions.filter((v) => !v.isMain).length ?? 0),
    0
  );
  const totalPublicados = ideas.filter((i) => i.status === "publicado").length;

  const hasActiveFilters =
    selectedPlatforms.length > 0 ||
    selectedStatuses.length > 0 ||
    versionFilter !== "all";

  // ── Renders de estado ────────────────────────────────────────────────────────
  if (loading)
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4">
        <div className="relative w-10 h-10">
          <motion.span
            className="absolute inset-0 rounded-full border-2 border-primary/30"
            style={{ borderTopColor: "var(--primary)" }}
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
          />
        </div>
        <p className="text-muted-foreground text-sm">Cargando taller...</p>
      </div>
    );

  if (error)
    return (
      <div className="p-6 m-6 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm flex items-center gap-2">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    );

  // El Taller (ideas centrales) se genera con la IA de esse-Transcrip.
  // Si no está activo y no hay ideas, mostramos el aviso para habilitarlo.
  if (!transcripLoading && transcrip && !transcrip.active && ideas.length === 0)
    return (
      <div className="px-3 sm:px-6 py-8">
        <TranscripRequired feature="El Taller" />
      </div>
    );

  return (
    <div
      className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 sm:py-6 sm:pb-0 space-y-4"
      style={{ fontFamily: "'Inter', sans-serif", paddingBottom: "max(5rem, calc(env(safe-area-inset-bottom) + 5rem))" }}
    >
      {/* ── Cabecera ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Taller</h2>
          <p className="text-muted-foreground text-xs mt-0.5">
            Versiones y borradores de cada video original
          </p>
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
            Filtros{hasActiveFilters ? ` (${
              selectedPlatforms.length + selectedStatuses.length + (versionFilter !== "all" ? 1 : 0)
            })` : ""}
          </button>
        </div>
      </div>

      {/* ── Panel de Filtros ───────────────────────────────────────────────── */}
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
          {[
            {
              label: "Plataforma",
              chips: ["youtube", "instagram", "tiktok"].map((p) => ({
                label: p.charAt(0).toUpperCase() + p.slice(1),
                active: selectedPlatforms.includes(p),
                onClick: () => toggleChip(selectedPlatforms, setSelectedPlatforms, p),
              })),
            },
            {
              label: "Estado",
              chips: (["publicado", "borrador", "procesando"] as IdeaStatus[]).map((s) => ({
                label: STATUS_CONFIG[s].label,
                active: selectedStatuses.includes(s),
                onClick: () => toggleChip(selectedStatuses, setSelectedStatuses, s),
              })),
            },
            {
              label: "Versión",
              chips: [
                { label: "Solo originales", active: versionFilter === "only-originals", onClick: () => toggleVersionFilter("only-originals") },
                { label: "Con versiones", active: versionFilter === "with-versions", onClick: () => toggleVersionFilter("with-versions") },
              ],
            },
          ].map(({ label, chips }) => (
            <div key={label} className="space-y-1.5 sm:space-y-0 sm:flex sm:items-center sm:gap-4">
              <span className="block text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sm:w-20 sm:flex-shrink-0">
                {label}
              </span>
              <div className="flex gap-2 flex-wrap">
                {chips.map((c) => <FilterChip key={c.label} {...c} />)}
              </div>
            </div>
          ))}

          {/* Limpiar filtros */}
          {hasActiveFilters && (
            <div className="pt-1 border-t border-border/40">
              <button
                onClick={() => {
                  setSelectedPlatforms([]);
                  setSelectedStatuses([]);
                  setVersionFilter("all");
                }}
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

      {/* ── Contadores ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <div className="bg-card/40 border border-border/60 rounded-xl p-3 sm:p-4">
          <p className="text-foreground text-base sm:text-lg font-mono">
            {String(totalOriginales).padStart(2, "0")}
          </p>
          <p className="text-muted-foreground text-[10px] sm:text-xs mt-0.5">Videos originales</p>
        </div>
        <div className="bg-card/40 border border-border/60 rounded-xl p-3 sm:p-4">
          <p className="text-foreground text-base sm:text-lg font-mono">
            {String(totalVersiones).padStart(2, "0")}
          </p>
          <p className="text-muted-foreground text-[10px] sm:text-xs mt-0.5">Versiones previas</p>
        </div>
        <div className="bg-card/40 border border-border/60 rounded-xl p-3 sm:p-4">
          <p className="text-foreground text-base sm:text-lg font-mono">
            {String(totalPublicados).padStart(2, "0")}
          </p>
          <p className="text-muted-foreground text-[10px] sm:text-xs mt-0.5">Publicados</p>
        </div>
      </div>

      {/* ── Lista de videos ────────────────────────────────────────────────── */}
      <div className="space-y-2">
        {/* Encabezado tabla — oculto en móvil */}
        <div className="hidden sm:flex items-center px-4 py-1 text-[11px] font-medium text-muted-foreground tracking-wider uppercase gap-4">
          {selectionMode && <div className="w-5 flex-shrink-0" />}
          <div className="w-5 flex-shrink-0" />
          <div className="w-14 flex-shrink-0" />
          <div className="flex-1">Título</div>
          <div className="w-20 text-center">Ratio</div>
          <div className="w-24 text-right pr-8">Fecha</div>
        </div>

        {currentIdeas.length === 0 && (
          <div className="py-12 text-center text-muted-foreground text-sm">
            No hay videos que coincidan con los filtros activos.
          </div>
        )}

        {currentIdeas.map((idea, ideaIdx) => {
          const vp = idea.videosOriginales[0];
          const principal = vp?.versions.find((v) => v.isMain);
          const alternatives = vp?.versions.filter((v) => !v.isMain) ?? [];
          const isExpanded = expandedItems.includes(idea._id);
          const isSelected = selectedIds.includes(idea._id);
          const ideaStatus = (idea.status ?? "borrador") as IdeaStatus;
          const statusCfg = STATUS_CONFIG[ideaStatus];

          return (
            <motion.div
              key={idea._id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: ideaIdx * 0.04, duration: 0.22, ease: "easeOut" }}
              className="bg-card/20 border border-border rounded-xl overflow-hidden"
            >
              {/* Fila principal */}
              <div
                onClick={() => alternatives.length > 0 && toggleExpand(idea._id)}
                className={`flex items-center gap-3 px-4 py-3 transition-colors
                  ${alternatives.length > 0 ? "cursor-pointer hover:bg-secondary/10" : "hover:bg-secondary/5"}
                  ${isSelected ? "bg-primary/5" : ""}
                  ${alternatives.length > 0 ? (isExpanded ? "border-l-4 border-l-primary" : "border-l-4 border-l-primary/30") : "border-l-4 border-l-transparent"}
                `}
              >
                {/* Checkbox de selección */}
                {selectionMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleSelect(idea._id); }}
                    className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                      isSelected
                        ? "bg-primary border-primary"
                        : "border-border hover:border-primary/60"
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                  </button>
                )}

                {/* Thumbnail */}
                <div className="relative w-20 h-12 sm:w-24 sm:h-14 rounded-lg overflow-hidden bg-secondary flex-shrink-0 border border-border/60">
                  <img
                    src={principal?.thumbnail ?? vp?.thumbnail}
                    alt={principal?.title ?? idea.title}
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute bottom-1 right-1 bg-black/80 text-[10px] px-1 rounded font-mono text-white">
                    {principal?.duration ?? vp?.duration ?? "0:00"}
                  </span>
                </div>

                {/* Título + subtítulo */}
                <div className="flex-1 min-w-0">
                  <p className="text-foreground text-sm font-medium truncate">
                    {principal?.title ?? idea.title}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap mt-0.5">
                    <span className="text-muted-foreground text-[11px]">
                      {alternatives.length > 0
                        ? `${alternatives.length} ${alternatives.length === 1 ? "versión previa" : "versiones previas"}`
                        : "Sin versiones previas"}
                    </span>
                    {/* Ratio y fecha visibles en móvil dentro del subtítulo */}
                    <span className="sm:hidden text-[10px] text-muted-foreground/60 font-mono border border-border/40 px-1 rounded">
                      {principal?.ratio ?? vp?.ratio ?? "16:9"}
                    </span>
                    <span className="sm:hidden text-[10px] text-muted-foreground/50 font-mono">
                      {principal?.uploadedAt ?? vp?.uploadedAt ?? "—"}
                    </span>
                  </div>
                </div>

                {/* Badge de estado (con dropdown solo para todopoderoso) */}
                <div className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                  {role === "todopoderoso" ? (
                    <>
                      <button
                        onClick={() =>
                          setOpenStatusId(openStatusId === idea._id ? null : idea._id)
                        }
                        className={`text-[10px] px-2 py-0.5 rounded border font-medium transition-opacity hover:opacity-80 ${statusCfg.chipClass}`}
                      >
                        {statusCfg.label}
                      </button>
                      {openStatusId === idea._id && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setOpenStatusId(null)} />
                          <div className="absolute right-0 mt-1.5 w-40 rounded-xl bg-card border border-border shadow-2xl p-1.5 z-20 space-y-0.5">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1">
                              Cambiar estado
                            </p>
                            {(Object.entries(STATUS_CONFIG) as [IdeaStatus, typeof STATUS_CONFIG[IdeaStatus]][]).map(([key, cfg]) => (
                              <button
                                key={key}
                                onClick={() => handleStatusChange(idea._id, key)}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                                  ideaStatus === key ? "bg-secondary/60 font-medium" : "hover:bg-secondary/40 text-muted-foreground hover:text-foreground"
                                }`}
                              >
                                <span className={cfg.chipClass.split(" ")[0]}>{cfg.label}</span>
                                {ideaStatus === key && <Check className="w-3 h-3 text-muted-foreground" />}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${statusCfg.chipClass}`}>
                      {statusCfg.label}
                    </span>
                  )}
                </div>

                {/* Ratio — solo sm+ */}
                <div className="hidden sm:flex w-20 justify-center">
                  <span className="text-[10px] text-muted-foreground font-mono border border-border/40 px-1.5 py-0.5 rounded">
                    {principal?.ratio ?? vp?.ratio ?? "16:9"}
                  </span>
                </div>

                {/* Fecha — solo sm+ */}
                <div className="hidden sm:block w-24 text-right text-xs text-muted-foreground font-mono">
                  {principal?.uploadedAt ?? vp?.uploadedAt ?? "—"}
                </div>

                {/* Borrar idea — solo todopoderoso */}
                {role === "todopoderoso" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteIdea(idea._id, idea.title); }}
                    className="text-muted-foreground/40 hover:text-red-400 p-1.5 transition-colors flex-shrink-0"
                    title="Eliminar esta idea y todo su contenido"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Versiones alternativas (expandidas) */}
              <AnimatePresence initial={false}>
              {isExpanded && alternatives.length > 0 && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                  style={{ overflow: "hidden" }}
                >
                <div className="bg-black/15 divide-y divide-border/20 border-t border-border/30">
                  {alternatives.map((ver, verIdx) => (
                    <motion.div
                      key={ver._id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: verIdx * 0.05, duration: 0.18 }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-secondary/10 transition-colors"
                    >
                      <div className="relative w-20 h-12 sm:w-24 sm:h-14 rounded-lg overflow-hidden bg-secondary/50 flex-shrink-0 border border-border/60">
                        <img
                          src={ver.thumbnail}
                          alt={ver.title}
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute bottom-1 right-1 bg-black/80 text-[10px] px-1 rounded font-mono text-white">
                          {ver.duration}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-foreground text-sm font-medium truncate">
                          {ver.title}
                        </p>
                        {/* Ratio y fecha en móvil */}
                        <div className="sm:hidden flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted-foreground/50 font-mono">{ver.ratio}</span>
                          <span className="text-[10px] text-muted-foreground/40 font-mono">{ver.uploadedAt}</span>
                        </div>
                      </div>
                      <div className="hidden sm:flex w-20 justify-center">
                        <span className="text-[10px] text-muted-foreground/50 font-mono">
                          {ver.ratio}
                        </span>
                      </div>
                      <div className="hidden sm:block w-24 text-right text-xs text-muted-foreground/40 font-mono">
                        {ver.uploadedAt}
                      </div>
                      {role === "todopoderoso" && (
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleSetMain(idea._id, ver._id)}
                            className="flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-md text-[10px] font-medium border transition-all bg-secondary/40 border-border text-muted-foreground hover:text-foreground hover:bg-secondary whitespace-nowrap"
                          >
                            ⇆ <span className="hidden sm:inline">Principal</span>
                          </button>
                          <button
                            onClick={() => handleDeleteVideo(idea._id, ver._id, ver.title)}
                            className="text-muted-foreground/40 hover:text-red-400 p-1 transition-colors"
                            title="Eliminar versión alternativa"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </motion.div>
                  ))}
                </div>
                </motion.div>
              )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>

      {/* ── Paginación ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between pt-4 text-xs text-muted-foreground border-t border-border/40 gap-2">
        <div className="hidden sm:block">
          Mostrando {totalItems === 0 ? 0 : indexOfFirstItem + 1}–
          {Math.min(indexOfLastItem, totalItems)} de {totalItems} videos
          {hasActiveFilters && ` (filtrado de ${ideas.length})`}
        </div>
        <div className="sm:hidden font-mono">
          {totalItems === 0 ? 0 : indexOfFirstItem + 1}–{Math.min(indexOfLastItem, totalItems)} / {totalItems}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
            disabled={currentPage === 1}
            className="px-2 py-1 rounded bg-secondary/50 border border-border hover:bg-secondary disabled:opacity-30 transition-colors"
          >
            ⟨
          </button>
          <span className="px-3 py-1 rounded bg-primary/20 text-primary border border-primary/30 font-mono font-semibold">
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
            disabled={currentPage === totalPages}
            className="px-2 py-1 rounded bg-secondary/50 border border-border hover:bg-secondary disabled:opacity-30 transition-colors"
          >
            ⟩
          </button>
        </div>
      </div>
    </div>
  );
}
