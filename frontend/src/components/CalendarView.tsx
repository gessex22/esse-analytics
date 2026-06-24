import { useState, useMemo, useCallback, useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronLeft, ChevronRight, CalendarDays,
  Play, Camera, Music2, X, Plus, Check, Trash2,
} from "lucide-react";
import { videoService, syncService, DashboardVideo } from "../services/api";

// ── Types ────────────────────────────────────────────────────────────────────

type Platform = "tiktok" | "instagram" | "youtube";

interface PlatformConfig {
  platform: Platform;
  lastPublishedTitle: string;
  lastPublishedDate: string; // YYYY-MM-DD
  intervalDays: number;
}

interface GeneratedSlot {
  id: string;        // `${platform}-${YYYY-MM-DD}`
  platform: Platform;
  date: string;      // YYYY-MM-DD
}

interface SlotAssignment {
  videoId: string;   // fileId
  videoTitle: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const DAYS_HEADER = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const STORAGE_KEY = "esse_calendar_slots_v1";

const FALLBACK_PLATFORM_CONFIGS: PlatformConfig[] = [
  { platform: "tiktok",    lastPublishedTitle: "Final Garantía", lastPublishedDate: "2026-06-19", intervalDays: 3 },
  { platform: "instagram", lastPublishedTitle: "Lag Minecraft",  lastPublishedDate: "2026-06-19", intervalDays: 3 },
  { platform: "youtube",   lastPublishedTitle: "Final Mac Neo",  lastPublishedDate: "2026-06-18", intervalDays: 4 },
];

const PLATFORM_CFG = {
  tiktok: {
    label:  "TikTok",
    icon:   Music2,
    dot:    "bg-pink-500",
    text:   "text-pink-500",
    light:  "bg-pink-500/10 text-pink-600",
    border: "border-pink-500/30",
  },
  instagram: {
    label:  "Instagram",
    icon:   Camera,
    dot:    "bg-purple-500",
    text:   "text-purple-500",
    light:  "bg-purple-500/10 text-purple-600",
    border: "border-purple-500/30",
  },
  youtube: {
    label:  "YouTube",
    icon:   Play,
    dot:    "bg-red-500",
    text:   "text-red-500",
    light:  "bg-red-500/10 text-red-600",
    border: "border-red-500/30",
  },
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function weekOffset(year: number, month: number): number {
  const day = new Date(year, month - 1, 1).getDay();
  return day === 0 ? 6 : day - 1;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function loadAssignments(): Record<string, SlotAssignment> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function saveAssignments(a: Record<string, SlotAssignment>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
}

function generateSlotsForMonth(
  configs: PlatformConfig[],
  year: number,
  month: number,
): GeneratedSlot[] {
  const mm = String(month).padStart(2, "0");
  const firstDay = `${year}-${mm}-01`;
  const lastDayNum = new Date(year, month, 0).getDate();
  const lastDay = `${year}-${mm}-${String(lastDayNum).padStart(2, "0")}`;
  const slots: GeneratedSlot[] = [];

  for (const cfg of configs) {
    const interval = cfg.intervalDays ?? 3;
    let next = addDays(cfg.lastPublishedDate, interval);
    while (next < firstDay) next = addDays(next, interval);
    while (next <= lastDay) {
      slots.push({ id: `${cfg.platform}-${next}`, platform: cfg.platform, date: next });
      next = addDays(next, interval);
    }
  }
  return slots.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PlatformBadge({ platform }: { platform: Platform }) {
  const cfg = PLATFORM_CFG[platform];
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${cfg.light}`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  );
}

function SlotChip({
  slot, assignment, onClick,
}: {
  slot: GeneratedSlot;
  assignment?: SlotAssignment;
  onClick: () => void;
}) {
  const cfg = PLATFORM_CFG[slot.platform];
  const Icon = cfg.icon;
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border transition-colors text-left ${
        assignment
          ? `${cfg.light} border-transparent hover:opacity-80`
          : "border-dashed border-border hover:border-primary/40 hover:bg-secondary/50"
      }`}
    >
      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
        assignment ? cfg.dot : "bg-secondary"
      }`}>
        <Icon className={`w-2.5 h-2.5 ${assignment ? "text-white" : "text-muted-foreground"}`} />
      </div>
      <div className="flex-1 min-w-0">
        {assignment
          ? <p className="text-xs font-medium truncate">{assignment.videoTitle}</p>
          : <p className="text-xs text-muted-foreground">Pendiente de asignar</p>
        }
      </div>
      {assignment
        ? <Check className="w-3 h-3 text-emerald-500 flex-shrink-0" />
        : <Plus className="w-3 h-3 text-muted-foreground flex-shrink-0" />
      }
    </button>
  );
}

function AssignModal({
  slot, currentAssignment, videos, loading, onAssign, onUnassign, onClose,
}: {
  slot: GeneratedSlot;
  currentAssignment?: SlotAssignment;
  videos: DashboardVideo[];
  loading: boolean;
  onAssign: (v: DashboardVideo) => void;
  onUnassign: () => void;
  onClose: () => void;
}) {
  const cfg = PLATFORM_CFG[slot.platform];
  const Icon = cfg.icon;
  const dateLabel = new Date(slot.date + "T00:00:00").toLocaleDateString("es", {
    weekday: "short", day: "numeric", month: "short",
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ y: 20, scale: 0.97 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 20, scale: 0.97 }}
        transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
        className="bg-card border border-border rounded-2xl w-full max-w-md overflow-hidden shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${cfg.dot}`}>
              <Icon className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{cfg.label}</p>
              <p className="text-xs text-muted-foreground">{dateLabel}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Current assignment */}
        {currentAssignment && (
          <div className={`mx-4 mt-3 p-3 rounded-xl flex items-center justify-between ${cfg.light}`}>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Asignado actualmente</p>
              <p className="text-sm font-medium">{currentAssignment.videoTitle}</p>
            </div>
            <button
              onClick={onUnassign}
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors ml-2"
              title="Quitar asignación"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Video list */}
        <div className="p-4">
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
            Videos renderizados disponibles
          </p>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-12 rounded-xl bg-secondary/50 animate-pulse" />
              ))}
            </div>
          ) : videos.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No hay videos disponibles
            </p>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {videos.map(v => {
                const vid = v.fileId || v._id;
                const isSelected = currentAssignment?.videoId === vid;
                return (
                  <button
                    key={vid}
                    onClick={() => onAssign(v)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-secondary/70 transition-colors text-left ${
                      isSelected ? "bg-secondary ring-1 ring-primary/30" : ""
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{v.title}</p>
                      <p className="text-xs text-muted-foreground">{v.duration}</p>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-primary flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function CalendarView({ role: _role }: { role: string }) {
  const today = new Date();

  const [year, setYear]               = useState(today.getFullYear());
  const [month, setMonth]             = useState(today.getMonth() + 1);
  const [assignments, setAssignments] = useState<Record<string, SlotAssignment>>(loadAssignments);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [modalSlot, setModalSlot]     = useState<GeneratedSlot | null>(null);
  const [availableVideos, setAvailableVideos] = useState<DashboardVideo[]>([]);
  const [loadingVideos, setLoadingVideos]     = useState(false);
  const [activeFilters, setActiveFilters]     = useState<Set<Platform>>(
    new Set<Platform>(["tiktok", "instagram", "youtube"]),
  );
  const [platformConfigs, setPlatformConfigs] = useState<PlatformConfig[]>(FALLBACK_PLATFORM_CONFIGS);

  // Cargar config real desde el backend
  useEffect(() => {
    syncService.getCalendarConfig()
      .then(data => {
        const configs = data
          .filter(c => ["tiktok", "instagram", "youtube"].includes(c.platform))
          .map(c => ({ ...c, platform: c.platform as Platform }));
        if (configs.length > 0) setPlatformConfigs(configs);
      })
      .catch(() => { /* usa fallback */ });
  }, []);

  // Cambiar el intervalo de días de una plataforma (optimista + persiste en backend)
  const updateInterval = useCallback((platform: Platform, days: number) => {
    if (!Number.isFinite(days) || days < 1) return;
    setPlatformConfigs(prev => prev.map(c =>
      c.platform === platform ? { ...c, intervalDays: days } : c
    ));
    syncService.updateCalendarConfig(platform, { intervalDays: days }).catch(() => {});
  }, []);

  // Slots generados para el mes visible
  const allSlots = useMemo(
    () => generateSlotsForMonth(platformConfigs, year, month),
    [platformConfigs, year, month],
  );

  const visibleSlots = useMemo(
    () => allSlots.filter(s => activeFilters.has(s.platform)),
    [allSlots, activeFilters],
  );

  const slotsByDay = useMemo<Record<number, GeneratedSlot[]>>(() => {
    const map: Record<number, GeneratedSlot[]> = {};
    for (const s of visibleSlots) {
      const d = parseInt(s.date.slice(8, 10), 10);
      if (!map[d]) map[d] = [];
      map[d].push(s);
    }
    return map;
  }, [visibleSlots]);

  const cells = useMemo<(number | null)[]>(() => {
    const daysInMonth = new Date(year, month, 0).getDate();
    const offset = weekOffset(year, month);
    const arr: (number | null)[] = Array.from({ length: offset }, () => null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(d);
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [year, month]);

  const isToday = (d: number) =>
    d === today.getDate() &&
    month === today.getMonth() + 1 &&
    year === today.getFullYear();

  const selectedSlots = selectedDay != null ? (slotsByDay[selectedDay] ?? []) : [];

  const stats = useMemo(() => {
    let assigned = 0;
    for (const s of visibleSlots) { if (assignments[s.id]) assigned++; }
    return { assigned, pending: visibleSlots.length - assigned, total: visibleSlots.length };
  }, [visibleSlots, assignments]);

  // ── Navigation ──────────────────────────────────────────────────────────────

  const prevMonth = useCallback(() => {
    setSelectedDay(null);
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  }, [month]);

  const nextMonth = useCallback(() => {
    setSelectedDay(null);
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  }, [month]);

  const goToToday = useCallback(() => {
    setSelectedDay(null);
    setYear(today.getFullYear());
    setMonth(today.getMonth() + 1);
  }, []);

  // ── Slot actions ────────────────────────────────────────────────────────────

  const openModal = useCallback((slot: GeneratedSlot) => {
    setModalSlot(slot);
    if (availableVideos.length === 0 && !loadingVideos) {
      setLoadingVideos(true);
      videoService
        .getAllVideos(1, 50)
        .then(({ videos }) => setAvailableVideos(videos))
        .catch(() => setAvailableVideos([]))
        .finally(() => setLoadingVideos(false));
    }
  }, [availableVideos.length, loadingVideos]);

  const assignVideo = useCallback((video: DashboardVideo) => {
    if (!modalSlot) return;
    const next = {
      ...assignments,
      [modalSlot.id]: { videoId: video.fileId || video._id, videoTitle: video.title },
    };
    setAssignments(next);
    saveAssignments(next);
    setModalSlot(null);
  }, [modalSlot, assignments]);

  const unassignSlot = useCallback((slotId: string) => {
    const next = { ...assignments };
    delete next[slotId];
    setAssignments(next);
    saveAssignments(next);
    setModalSlot(null);
  }, [assignments]);

  const toggleFilter = useCallback((p: Platform) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(p) && next.size > 1) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 pb-4">

      {/* ── Header: navegación + stats ───────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-base font-semibold text-foreground w-48 text-center select-none">
            {MONTHS_ES[month - 1]} {year}
          </span>
          <button
            onClick={nextMonth}
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={goToToday}
            className="ml-1 px-2.5 py-1 text-xs rounded-lg border border-border hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            Hoy
          </button>
        </div>

        {stats.total > 0 && (
          <div className="flex items-center gap-3 sm:ml-auto text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              {stats.assigned} asignados
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-border border border-muted-foreground/20" />
              {stats.pending} pendientes
            </span>
          </div>
        )}
      </div>

      {/* ── Filtros de plataforma ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["tiktok", "instagram", "youtube"] as Platform[]).map(p => {
          const cfg = PLATFORM_CFG[p];
          const Icon = cfg.icon;
          const active = activeFilters.has(p);
          return (
            <button
              key={p}
              onClick={() => toggleFilter(p)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                active
                  ? `${cfg.light} ${cfg.border}`
                  : "border-transparent text-muted-foreground hover:bg-secondary"
              }`}
            >
              <Icon className="w-3 h-3" />
              {cfg.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-3 flex-wrap">
          {(["tiktok", "instagram", "youtube"] as Platform[]).map(p => {
            const cfg = platformConfigs.find(c => c.platform === p);
            const Icon = PLATFORM_CFG[p].icon;
            return (
              <label key={p} className="flex items-center gap-1 text-xs text-muted-foreground" title={`Publicar en ${PLATFORM_CFG[p].label} cada N días`}>
                <Icon className={`w-3 h-3 ${PLATFORM_CFG[p].text}`} />
                cada
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={cfg?.intervalDays ?? 3}
                  onChange={(e) => updateInterval(p, parseInt(e.target.value, 10))}
                  className="w-11 px-1 py-0.5 bg-secondary/40 border border-border rounded text-center text-foreground focus:outline-none focus:border-primary/50"
                />
                días
              </label>
            );
          })}
        </div>
      </div>

      {/* ── Calendario + panel ───────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row gap-4">

        {/* Cuadrícula */}
        <div className="flex-1 min-w-0">
          <div className="grid grid-cols-7 mb-1">
            {DAYS_HEADER.map(d => (
              <div key={d} className="text-center text-xs font-medium text-muted-foreground py-2">
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((day, i) => {
              if (!day) return <div key={`e${i}`} className="aspect-square" />;

              const daySlots  = slotsByDay[day] ?? [];
              const isSelected = selectedDay === day;
              const todayCell  = isToday(day);
              const hasSlots   = daySlots.length > 0;

              return (
                <motion.button
                  key={day}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setSelectedDay(isSelected ? null : day)}
                  className={`aspect-square rounded-xl p-1 flex flex-col items-center justify-start transition-colors ${
                    isSelected
                      ? "bg-primary/10 ring-2 ring-primary/30"
                      : hasSlots
                      ? "hover:bg-secondary cursor-pointer"
                      : "cursor-default opacity-50"
                  }`}
                >
                  <span
                    className={`text-xs sm:text-sm font-medium leading-none mb-1 w-6 h-6 flex items-center justify-center rounded-full flex-shrink-0 ${
                      todayCell
                        ? "bg-primary text-primary-foreground"
                        : isSelected
                        ? "text-primary font-semibold"
                        : "text-foreground"
                    }`}
                  >
                    {day}
                  </span>

                  {/* Puntos: plataforma coloreada si asignada, gris si pendiente */}
                  {hasSlots && (
                    <div className="flex flex-wrap justify-center gap-0.5 max-w-full">
                      {daySlots.slice(0, 3).map((s, si) => (
                        <span
                          key={si}
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            assignments[s.id]
                              ? PLATFORM_CFG[s.platform].dot
                              : "bg-muted-foreground/25"
                          }`}
                        />
                      ))}
                      {daySlots.length > 3 && (
                        <span className="text-[9px] text-muted-foreground leading-none self-center">
                          +{daySlots.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </motion.button>
              );
            })}
          </div>

          {visibleSlots.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center">
                <CalendarDays className="w-7 h-7 text-muted-foreground/50" />
              </div>
              <p className="text-muted-foreground text-sm">
                No hay slots en {MONTHS_ES[month - 1]} {year}
              </p>
            </div>
          )}
        </div>

        {/* ── Panel de día ──────────────────────────────────────────────── */}
        <AnimatePresence>
          {selectedDay != null && (
            <motion.div
              key="detail-panel"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              className="lg:w-72 xl:w-80 flex-shrink-0 bg-card border border-border rounded-2xl overflow-hidden self-start"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/30">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {selectedDay} de {MONTHS_ES[month - 1]}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selectedSlots.length} slot{selectedSlots.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedDay(null)}
                  className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {selectedSlots.length > 0 ? (
                <div className="p-3 space-y-3 overflow-y-auto max-h-[60vh] lg:max-h-[70vh]">
                  {selectedSlots.map(slot => (
                    <div key={slot.id} className="space-y-1.5">
                      <PlatformBadge platform={slot.platform} />
                      <SlotChip
                        slot={slot}
                        assignment={assignments[slot.id]}
                        onClick={() => openModal(slot)}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-10 flex flex-col items-center gap-2 text-center">
                  <CalendarDays className="w-8 h-8 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">No hay slots en este día</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Modal de asignación ────────────────────────────────────────────── */}
      <AnimatePresence>
        {modalSlot && (
          <AssignModal
            slot={modalSlot}
            currentAssignment={assignments[modalSlot.id]}
            videos={availableVideos}
            loading={loadingVideos}
            onAssign={assignVideo}
            onUnassign={() => unassignSlot(modalSlot.id)}
            onClose={() => setModalSlot(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
