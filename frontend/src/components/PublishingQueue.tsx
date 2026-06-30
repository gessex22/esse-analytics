import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import {
  Play, Camera, Music2, AlertTriangle, Clock,
  ChevronLeft, ChevronRight, Pin, Loader2, Check, Clapperboard, RefreshCw,
} from "lucide-react";
import { videoService, syncService } from "../services/api";

type SlimVideo = { fileId: string; title: string; duration: string };
import {
  Platform, PlatformSlot, calcNextDate, FALLBACK_SLOTS,
} from "../data/mockPublishingData";

// ── Config ────────────────────────────────────────────────────────────────────

const PLATFORM_CFG = {
  tiktok:    { label: "TikTok",    icon: Music2,  bg: "bg-pink-500",   ring: "ring-pink-500/30",   border: "border-l-pink-500",   grad: "from-pink-500 to-rose-600"      },
  instagram: { label: "Instagram", icon: Camera,  bg: "bg-purple-500", ring: "ring-purple-500/30", border: "border-l-purple-500", grad: "from-purple-500 to-fuchsia-600" },
  youtube:   { label: "YouTube",   icon: Play,    bg: "bg-red-500",    ring: "ring-red-500/30",    border: "border-l-red-500",    grad: "from-red-500 to-red-700"        },
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Urgency = "past" | "today" | "soon" | "ok";

function getUrgency(next: string): Urgency {
  const t = todayStr();
  if (next < t) return "past";
  if (next === t) return "today";
  const diff = (new Date(next + "T00:00:00").getTime() - new Date(t + "T00:00:00").getTime()) / 86400000;
  return diff <= 1 ? "soon" : "ok";
}

function formatShortDate(s: string) {
  if (!s) return "—";
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es", { day: "numeric", month: "short" });
}

function formatLongDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
}

const URGENCY_STYLE: Record<Urgency, { pill: string; label: string; icon: typeof AlertTriangle | typeof Clock }> = {
  past:  { pill: "bg-red-500/15 text-red-500",    label: "Vencido",  icon: AlertTriangle },
  today: { pill: "bg-orange-500/15 text-orange-500", label: "Hoy",   icon: Clock },
  soon:  { pill: "bg-amber-400/15 text-amber-600",   label: "Mañana", icon: Clock },
  ok:    { pill: "bg-secondary text-muted-foreground", label: "",     icon: Clock },
};

const URGENCY_BORDER: Record<Urgency, string> = {
  past:  "border-l-red-500",
  today: "border-l-orange-500",
  soon:  "border-l-amber-400",
  ok:    "border-l-transparent",
};

// ── Types ─────────────────────────────────────────────────────────────────────

type PublishedVideo = {
  platform:    Platform;
  fileName:    string | null;
  platformId:  string | null;
  platformUrl: string | null;
  publishedAt: string | null;
  title?:      string | null;
  status?:     string | null;
  stats?:      Record<string, any>;
};

// ── Inline interval editor ────────────────────────────────────────────────────

function IntervalChip({ days, onChange }: { days: number; onChange: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(days));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  useEffect(() => { setVal(String(days)); }, [days]);

  function commit() {
    const n = parseInt(val, 10);
    if (Number.isFinite(n) && n >= 1) onChange(n);
    else setVal(String(days));
    setEditing(false);
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-foreground">
        cada
        <input
          ref={inputRef}
          type="number"
          min={1}
          max={60}
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          className="w-6 text-center bg-transparent focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        d
      </span>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      title="Editar intervalo"
      className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground hover:text-foreground transition-colors"
    >
      cada {days}d
    </button>
  );
}

// ── Stats chips for published section ────────────────────────────────────────

function getStatChips(stats?: Record<string, any>, platform?: Platform) {
  if (!stats || !platform) return [];
  const n = (v: any) => Number.isFinite(+v) ? (+v).toLocaleString() : "—";
  if (platform === "youtube")   return [
    stats.viewCount    ? { l: "vistas",   v: n(stats.viewCount) }    : null,
    stats.likeCount    ? { l: "likes",    v: n(stats.likeCount) }    : null,
    stats.commentCount ? { l: "coment.",  v: n(stats.commentCount) } : null,
  ].filter(Boolean) as { l: string; v: string }[];
  if (platform === "instagram") return [
    stats.like_count     ? { l: "likes",   v: n(stats.like_count) }     : null,
    stats.comments_count ? { l: "coment.", v: n(stats.comments_count) } : null,
  ].filter(Boolean) as { l: string; v: string }[];
  if (platform === "tiktok") return [
    stats.views    ? { l: "vistas",  v: n(stats.views) }    : null,
    stats.likes    ? { l: "likes",   v: n(stats.likes) }    : null,
    stats.comments ? { l: "coment.", v: n(stats.comments) } : null,
  ].filter(Boolean) as { l: string; v: string }[];
  return [];
}

// ── Platform row ──────────────────────────────────────────────────────────────

function PlatformRow({
  slot, videos, index, onOlder, onNewer, onPin, onOpen, onIntervalChange, pinning, pinned, loading,
}: {
  slot: PlatformSlot; videos: SlimVideo[]; index: number;
  onOlder: () => void; onNewer: () => void; onPin: () => void; onOpen: () => void;
  onIntervalChange: (d: number) => void; pinning: boolean; pinned: boolean; loading: boolean;
}) {
  const cfg     = PLATFORM_CFG[slot.platform];
  const Icon    = cfg.icon;
  const urgency = slot.nextDate ? getUrgency(slot.nextDate) : "ok";
  const urg     = URGENCY_STYLE[urgency];
  const UrgIcon = urg.icon;
  const video   = videos[index];
  const total   = videos.length;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl bg-card border border-border border-l-4 ${URGENCY_BORDER[urgency]}`}
    >
      {/* Platform icon */}
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
        <Icon className="w-4 h-4 text-white" />
      </div>

      {/* Name + urgency */}
      <div className="w-[90px] flex-shrink-0">
        <p className="text-xs font-semibold text-foreground leading-tight">{cfg.label}</p>
        {slot.nextDate && (
          <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${urg.pill} px-1 py-0 rounded-full`}>
            {urgency !== "ok" && <UrgIcon className="w-2.5 h-2.5" />}
            {urg.label || formatShortDate(slot.nextDate)}
          </span>
        )}
      </div>

      {/* Video navigator */}
      <div className="flex-1 flex items-center gap-1 min-w-0">
        <button
          onClick={onOlder}
          disabled={loading || index >= total - 1}
          className="p-0.5 rounded hover:bg-secondary disabled:opacity-20 transition-colors flex-shrink-0"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0 text-center px-1">
          {loading ? (
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Cargando…
            </p>
          ) : total === 0 ? (
            <p className="text-xs text-muted-foreground">Sin videos</p>
          ) : (
            <>
              <p className="text-xs font-medium text-foreground truncate">{video?.title ?? "—"}</p>
              <p className="text-[10px] text-muted-foreground">
                {video?.duration ?? ""}
                {total > 0 && <span className="ml-1 opacity-60">{index + 1}/{total}</span>}
              </p>
            </>
          )}
        </div>

        <button
          onClick={onNewer}
          disabled={loading || index <= 0}
          className="p-0.5 rounded hover:bg-secondary disabled:opacity-20 transition-colors flex-shrink-0"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Date + interval */}
      <div className="hidden sm:flex flex-col items-end gap-0.5 flex-shrink-0 w-[80px]">
        {slot.nextDate && (
          <span className="text-[10px] text-muted-foreground">{formatShortDate(slot.nextDate)}</span>
        )}
        <IntervalChip days={slot.intervalDays} onChange={onIntervalChange} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={onOpen}
          disabled={loading || !video}
          title="Ver video"
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-20 transition-colors"
        >
          <Clapperboard className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onPin}
          disabled={loading || pinning || pinned || !video}
          title={pinned ? "Fijado" : "Fijar como publicado y avanzar"}
          className={`p-1.5 rounded-lg transition-colors ${
            pinned
              ? "text-emerald-500 bg-emerald-500/10 cursor-default"
              : "text-primary hover:bg-primary/10 disabled:opacity-30"
          }`}
        >
          {pinning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
           pinned  ? <Check   className="w-3.5 h-3.5" /> :
                     <Pin     className="w-3.5 h-3.5" />}
        </button>
      </div>
    </motion.div>
  );
}

// ── Published row ─────────────────────────────────────────────────────────────

function PublishedRow({ data }: { data: PublishedVideo }) {
  const cfg       = PLATFORM_CFG[data.platform];
  const Icon      = cfg.icon;
  const chips     = getStatChips(data.stats, data.platform).slice(0, 3);
  const thumbnail = data.stats?.thumbnail as string | undefined;
  const empty     = !data.platformId;

  return (
    <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border bg-card">

      {/* Thumbnail 9:16 — con placeholder cuando no hay miniatura (ej. TikTok) */}
      {thumbnail ? (
        <div className="rounded-lg overflow-hidden bg-black flex-shrink-0" style={{ width: 40, aspectRatio: "9/16" }}>
          <img src={thumbnail} alt="" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div
          className={`rounded-lg flex items-center justify-center flex-shrink-0 bg-gradient-to-br ${cfg.grad}`}
          style={{ width: 40, aspectRatio: "9/16" }}
        >
          <Icon className="w-5 h-5 text-white/90" />
        </div>
      )}

      {/* Platform */}
      <div className="w-[90px] flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <div className={`w-5 h-5 rounded-md flex items-center justify-center ${cfg.bg}`}>
            <Icon className="w-2.5 h-2.5 text-white" />
          </div>
          <span className="text-xs font-semibold text-foreground">{cfg.label}</span>
        </div>
        {data.publishedAt && (
          <p className="text-[10px] text-muted-foreground mt-0.5">{formatLongDate(data.publishedAt)}</p>
        )}
      </div>

      {/* Filename + title */}
      <div className="flex-1 min-w-0">
        {empty ? (
          <p className="text-xs text-muted-foreground">Sin publicaciones</p>
        ) : (
          <>
            <p className="text-xs font-medium text-foreground truncate">{data.fileName ?? "—"}</p>
            {data.title && data.platform !== "tiktok" && (
              <p className="text-[10px] text-muted-foreground truncate italic">{data.title}</p>
            )}
          </>
        )}
      </div>

      {/* Stats */}
      {chips.length > 0 && (
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          {chips.map((c, i) => (
            <div key={i} className="text-center">
              <p className="text-xs font-bold text-foreground leading-none">{c.v}</p>
              <p className="text-[9px] text-muted-foreground">{c.l}</p>
            </div>
          ))}
        </div>
      )}

      {/* Link */}
      {data.platformUrl && data.platform !== "tiktok" && (
        <a
          href={data.platformUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-primary hover:underline flex-shrink-0"
        >
          ↗
        </a>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PublishingQueue({ role: _role, onOpenVideo }: { role: string; onOpenVideo?: (fileId: string, title: string) => void }) {
  const [videos,    setVideos]    = useState<SlimVideo[]>([]);
  const [slots,     setSlots]     = useState<PlatformSlot[]>(FALLBACK_SLOTS);
  const [loading,   setLoading]   = useState(true);
  const [published, setPublished] = useState<PublishedVideo[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [indices, setIndices] = useState<Record<Platform, number>>({ tiktok: 0, instagram: 0, youtube: 0 });
  const [pinning, setPinning] = useState<Record<Platform, boolean>>({ tiktok: false, instagram: false, youtube: false });
  const [pinned,  setPinned]  = useState<Record<Platform, boolean>>({ tiktok: false, instagram: false, youtube: false });

  function loadAll(showRefresh = false) {
    if (showRefresh) setRefreshing(true);
    let loadedVideos: SlimVideo[] = [];
    let loadedNextIds: Partial<Record<Platform, string>> = {};
    let videosOk = false;
    let configOk = false;
    let publishedOk = false;

    function resolve() {
      if (!videosOk || !configOk || !publishedOk) return;
      setLoading(false);
      setRefreshing(false);
      const idx: Record<Platform, number> = { tiktok: 0, instagram: 0, youtube: 0 };
      for (const p of ["tiktok", "instagram", "youtube"] as Platform[]) {
        const id = loadedNextIds[p];
        if (!id) continue;
        let found = loadedVideos.findIndex(v => v.fileId === id);
        if (found === -1) found = loadedVideos.findIndex(v => v.title === id);
        if (found !== -1) idx[p] = found;
      }
      setIndices(idx);
    }

    videoService.getSlimList()
      .then(v => { loadedVideos = v; setVideos(v); })
      .catch(() => {})
      .finally(() => { videosOk = true; resolve(); });

    syncService.getCalendarConfig()
      .then(data => {
        const built: PlatformSlot[] = (["tiktok", "instagram", "youtube"] as Platform[]).map(p => {
          const cfg = data.find(c => c.platform === p);
          if (!cfg) return FALLBACK_SLOTS.find(s => s.platform === p)!;
          if (cfg.nextVideoId) loadedNextIds[p] = cfg.nextVideoId;
          const intervalDays = cfg.intervalDays ?? 3;
          return {
            platform: p,
            lastTitle: cfg.lastPublishedTitle,
            lastDate: cfg.lastPublishedDate,
            lastVideoId: cfg.lastVideoId,
            intervalDays,
            nextDate: cfg.lastPublishedDate ? calcNextDate(cfg.lastPublishedDate, intervalDays) : "",
          };
        });
        setSlots(built);
      })
      .catch(() => {})
      .finally(() => { configOk = true; resolve(); });

    syncService.getPublishedVideos()
      .then(data => {
        setPublished(data as PublishedVideo[]);
        // Refrescar stats reales automáticamente
        return syncService.refreshAllStats();
      })
      .then(refreshResult => {
        // Los stats se actualizaron en el backend, volver a cargar tarjetas
        return syncService.getPublishedVideos();
      })
      .then(data => {
        setPublished(data as PublishedVideo[]);
      })
      .catch(() => {})
      .finally(() => { publishedOk = true; resolve(); });
  }

  useEffect(() => { loadAll(); }, []);

  function updateInterval(platform: Platform, days: number) {
    if (!Number.isFinite(days) || days < 1) return;
    setSlots(prev => prev.map(s =>
      s.platform === platform
        ? { ...s, intervalDays: days, nextDate: s.lastDate ? calcNextDate(s.lastDate, days) : s.nextDate }
        : s
    ));
    syncService.updateCalendarConfig(platform, { intervalDays: days }).catch(() => {});
  }

  function navigate(platform: Platform, dir: "older" | "newer") {
    setIndices(prev => ({
      ...prev,
      [platform]: dir === "older"
        ? Math.min(videos.length - 1, prev[platform] + 1)
        : Math.max(0, prev[platform] - 1),
    }));
    setPinned(prev => ({ ...prev, [platform]: false }));
  }

  async function pinVideo(platform: Platform) {
    const video = videos[indices[platform]];
    if (!video) return;
    const slot = slots.find(s => s.platform === platform);
    const intervalDays = slot?.intervalDays ?? 3;
    const today = todayStr();
    const nextIdx   = Math.max(0, indices[platform] - 1);
    const nextVideo = videos[nextIdx];

    setPinning(prev => ({ ...prev, [platform]: true }));
    try {
      await syncService.updateCalendarConfig(platform, {
        lastPublishedDate:  today,
        lastPublishedTitle: video.title,
        lastVideoId:        video.fileId,
        intervalDays,
        nextVideoId:        nextVideo?.title,
      });
      setSlots(prev => prev.map(s =>
        s.platform === platform
          ? { ...s, lastTitle: video.title, lastDate: today, lastVideoId: video.fileId, nextDate: calcNextDate(today, intervalDays) }
          : s
      ));
      setPinned(prev => ({ ...prev, [platform]: true }));
      setIndices(prev => ({ ...prev, [platform]: nextIdx }));
    } catch { /* no-op */ }
    finally { setPinning(prev => ({ ...prev, [platform]: false })); }
  }

  const PLATFORM_ORDER: Platform[] = ["youtube", "instagram", "tiktok"];

  return (
    <div className="flex flex-col gap-6 pb-4 w-full max-w-4xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Calendario</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Navegá entre videos · <Pin className="inline w-3 h-3 mb-0.5" /> fija el publicado · click en "cada Nd" para cambiar intervalo
          </p>
        </div>
        <button
          onClick={() => loadAll(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Actualizar
        </button>
      </div>

      {/* Próximas publicaciones */}
      <section className="flex flex-col gap-2">
        <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground px-1">
          Próxima publicación
        </p>
        {PLATFORM_ORDER.map(p => {
          const slot = slots.find(s => s.platform === p) ?? FALLBACK_SLOTS.find(s => s.platform === p)!;
          const currentVideo = videos[indices[p]];
          return (
            <PlatformRow
              key={p}
              slot={slot}
              videos={videos}
              index={indices[p]}
              onOlder={() => navigate(p, "older")}
              onNewer={() => navigate(p, "newer")}
              onPin={() => pinVideo(p)}
              onOpen={() => currentVideo && onOpenVideo?.(currentVideo.fileId, currentVideo.title)}
              onIntervalChange={d => updateInterval(p, d)}
              pinning={pinning[p]}
              pinned={pinned[p]}
              loading={loading}
            />
          );
        })}
      </section>

      {/* Último publicado */}
      <section className="flex flex-col gap-2">
        <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground px-1">
          Último publicado
        </p>
        {PLATFORM_ORDER.map(p => {
          const data = published.find(d => d.platform === p)
            ?? { platform: p, fileName: null, platformId: null, platformUrl: null, publishedAt: null };
          return <PublishedRow key={p} data={data} />;
        })}
      </section>

    </div>
  );
}
