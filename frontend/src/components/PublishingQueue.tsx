import { useState, useEffect } from "react";
import { motion } from "motion/react";
import {
  Play, Camera, Music2, AlertTriangle, Clock, Pencil,
  ChevronLeft, ChevronRight, Pin, Loader2, Check, Clapperboard,
} from "lucide-react";
import { videoService, syncService } from "../services/api";

type SlimVideo = { fileId: string; title: string; duration: string };
import {
  Platform, PlatformSlot, calcNextDate, FALLBACK_SLOTS,
} from "../data/mockPublishingData";

// ── Constants ────────────────────────────────────────────────────────────────

const PLATFORM_CFG = {
  tiktok: {
    label: "TikTok",
    icon:  Music2,
    bg:    "bg-pink-500",
    text:  "text-pink-500",
    light: "bg-pink-500/10",
  },
  instagram: {
    label: "Instagram",
    icon:  Camera,
    bg:    "bg-purple-500",
    text:  "text-purple-500",
    light: "bg-purple-500/10",
  },
  youtube: {
    label: "YouTube",
    icon:  Play,
    bg:    "bg-red-500",
    text:  "text-red-500",
    light: "bg-red-500/10",
  },
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Urgency = "past" | "today" | "soon" | "ok";

function getUrgency(nextDate: string): Urgency {
  const today = todayStr();
  if (nextDate < today) return "past";
  if (nextDate === today) return "today";
  const diff =
    (new Date(nextDate + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) /
    86400000;
  return diff <= 1 ? "soon" : "ok";
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es", {
    day: "numeric", month: "short",
  });
}

function daysLabel(nextDate: string): string {
  const today = todayStr();
  if (nextDate < today) {
    const diff = Math.round(
      (new Date(today + "T00:00:00").getTime() - new Date(nextDate + "T00:00:00").getTime()) / 86400000,
    );
    return `Hace ${diff}d`;
  }
  if (nextDate === today) return "Hoy";
  const diff = Math.round(
    (new Date(nextDate + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000,
  );
  return `En ${diff}d`;
}

// ── UrgencyPill ───────────────────────────────────────────────────────────────

function UrgencyPill({ urgency, nextDate, onEdit }: { urgency: Urgency; nextDate: string; onEdit?: () => void }) {
  const styles: Record<Urgency, string> = {
    past:  "bg-red-500/15 text-red-500",
    today: "bg-orange-500/15 text-orange-500",
    soon:  "bg-amber-400/15 text-amber-600",
    ok:    "bg-secondary text-muted-foreground",
  };
  const Icon = urgency === "past" ? AlertTriangle : Clock;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${styles[urgency]}`}>
      <Icon className="w-2.5 h-2.5" />
      {daysLabel(nextDate)}
      {onEdit && (
        <button
          onClick={onEdit}
          title="Editar intervalo"
          className="ml-0.5 -mr-0.5 p-0.5 rounded-full hover:bg-black/10 transition-colors"
        >
          <Pencil className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  );
}

// ── PlatformCard (compact: 2 filas) ──────────────────────────────────────────

function PlatformCard({
  slot,
  videos,
  index,
  onOlder,
  onNewer,
  onPin,
  onOpen,
  onIntervalChange,
  pinning,
  pinned,
  loading,
}: {
  slot: PlatformSlot;
  videos: SlimVideo[];
  index: number;
  onOlder: () => void;
  onNewer: () => void;
  onPin: () => void;
  onOpen: () => void;
  onIntervalChange: (days: number) => void;
  pinning: boolean;
  pinned: boolean;
  loading: boolean;
}) {
  const cfg     = PLATFORM_CFG[slot.platform];
  const Icon    = cfg.icon;
  const urgency = slot.nextDate ? getUrgency(slot.nextDate) : "ok";
  const [editingInterval, setEditingInterval] = useState(false);
  const video = videos[index];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex flex-col gap-2 p-3 rounded-xl border bg-card ${
        urgency === "past"  ? "border-red-500/30"    :
        urgency === "today" ? "border-orange-500/30" :
        "border-border"
      }`}
    >
      {/* Fila 1: icono · label · intervalo · urgencia */}
      <div className="flex items-center gap-2">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
          <Icon className="w-3.5 h-3.5 text-white" />
        </div>
        <span className="text-sm font-semibold text-foreground">{cfg.label}</span>

        {editingInterval ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-secondary text-foreground">
            Cada
            <input
              type="number"
              min={1}
              max={60}
              autoFocus
              value={slot.intervalDays}
              onChange={(e) => onIntervalChange(parseInt(e.target.value, 10))}
              onBlur={() => setEditingInterval(false)}
              onKeyDown={(e) => e.key === "Enter" && setEditingInterval(false)}
              className="w-7 text-center bg-transparent border-b border-dashed border-muted-foreground/50 focus:border-primary focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            />
            d
          </span>
        ) : (
          <button
            onClick={() => setEditingInterval(true)}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            title="Editar intervalo"
          >
            cada {slot.intervalDays}d
          </button>
        )}

        <div className="ml-auto flex-shrink-0">
          {slot.nextDate && (
            <UrgencyPill urgency={urgency} nextDate={slot.nextDate} />
          )}
        </div>
      </div>

      {/* Fila 2: navegación de video */}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-0.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Cargando…</span>
        </div>
      ) : videos.length === 0 ? (
        <p className="text-xs text-muted-foreground py-0.5">Sin videos disponibles</p>
      ) : (
        <div className="flex items-center gap-1">
          <button
            onClick={onOlder}
            disabled={index === videos.length - 1}
            className="p-0.5 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          <div className="flex-1 min-w-0 px-0.5">
            <p className="text-xs font-medium text-foreground truncate">{video?.title ?? "—"}</p>
            <p className="text-[10px] text-muted-foreground">
              {slot.nextDate ? formatDate(slot.nextDate) : "—"}
              {video?.duration ? ` · ${video.duration}` : ""}
            </p>
          </div>

          <button
            onClick={onNewer}
            disabled={index === 0}
            className="p-0.5 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onOpen}
            title="Ver video"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
          >
            <Clapperboard className="w-3 h-3" />
          </button>

          <button
            onClick={onPin}
            disabled={pinning || pinned}
            title={pinned ? "Fijado" : "Fijar como publicado"}
            className={`p-1 rounded transition-colors flex-shrink-0 ${
              pinned
                ? "text-emerald-500 cursor-default"
                : "text-primary hover:bg-primary/10 disabled:opacity-50"
            }`}
          >
            {pinning ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : pinned ? (
              <Check className="w-3 h-3" />
            ) : (
              <Pin className="w-3 h-3" />
            )}
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ── PublishedCard (compact: 1 fila horizontal) ────────────────────────────────

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

function formatPublishedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
}

function getStatChips(stats: Record<string, any> | undefined, platform: Platform): { label: string; value: string }[] {
  if (!stats) return [];
  const n = (v: any) => parseInt(v).toLocaleString();
  if (platform === "youtube") {
    return [
      stats.viewCount    ? { label: "Vistas",      value: n(stats.viewCount) }    : null,
      stats.likeCount    ? { label: "Likes",        value: n(stats.likeCount) }    : null,
      stats.commentCount ? { label: "Comentarios",  value: n(stats.commentCount) } : null,
    ].filter(Boolean) as { label: string; value: string }[];
  }
  if (platform === "instagram") {
    return [
      stats.like_count     ? { label: "Likes",       value: n(stats.like_count) }     : null,
      stats.comments_count ? { label: "Comentarios", value: n(stats.comments_count) } : null,
    ].filter(Boolean) as { label: string; value: string }[];
  }
  if (platform === "tiktok") {
    return [
      stats.views    ? { label: "Vistas",  value: n(stats.views) }    : null,
      stats.likes    ? { label: "Likes",   value: n(stats.likes) }    : null,
      stats.comments ? { label: "Coment.", value: n(stats.comments) } : null,
    ].filter(Boolean) as { label: string; value: string }[];
  }
  return [];
}

function PublishedCard({ data }: { data: PublishedVideo }) {
  const cfg  = PLATFORM_CFG[data.platform];
  const Icon = cfg.icon;
  const chips = getStatChips(data.stats, data.platform).slice(0, 3);
  const thumbnail = data.stats?.thumbnail as string | undefined;

  return (
    <div className="flex items-center gap-2.5 p-3 rounded-xl border border-border bg-card">
      {/* Miniatura 9:16 */}
      {thumbnail ? (
        <div
          className="rounded-lg overflow-hidden bg-black flex-shrink-0"
          style={{ width: 36, aspectRatio: "9/16" }}
        >
          <img src={thumbnail} alt="thumbnail" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div
          className={`rounded-lg flex items-center justify-center flex-shrink-0 ${cfg.bg}`}
          style={{ width: 36, aspectRatio: "9/16" }}
        >
          <Icon className="w-4 h-4 text-white" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-foreground">{cfg.label}</span>
          {data.publishedAt && (
            <span className="text-[10px] text-muted-foreground">{formatPublishedAt(data.publishedAt)}</span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground truncate">
          {data.fileName ?? "Sin publicaciones todavía"}
        </p>
        {data.title && data.platform !== "tiktok" && (
          <p className="text-[10px] text-muted-foreground truncate italic">{data.title}</p>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex gap-2 flex-shrink-0">
          {chips.map((c, i) => (
            <div key={i} className="text-center">
              <p className="text-xs font-bold text-foreground leading-none">{c.value}</p>
              <p className="text-[9px] text-muted-foreground">{c.label}</p>
            </div>
          ))}
        </div>
      )}

      {data.platformUrl && data.platform !== "tiktok" && (
        <a
          href={data.platformUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`text-[10px] font-medium ${cfg.text} hover:underline flex-shrink-0`}
        >
          ↗
        </a>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PublishingQueue({ role: _role, onOpenVideo }: { role: string; onOpenVideo?: (fileId: string, title: string) => void }) {
  const [videos,  setVideos]  = useState<SlimVideo[]>([]);
  const [slots,   setSlots]   = useState<PlatformSlot[]>(FALLBACK_SLOTS);
  const [loading, setLoading] = useState(true);
  const [published, setPublished] = useState<PublishedVideo[]>([]);

  const [indices, setIndices] = useState<Record<Platform, number>>({
    tiktok: 0, instagram: 0, youtube: 0,
  });
  const [pinning, setPinning] = useState<Record<Platform, boolean>>({
    tiktok: false, instagram: false, youtube: false,
  });
  const [pinned, setPinned] = useState<Record<Platform, boolean>>({
    tiktok: false, instagram: false, youtube: false,
  });

  useEffect(() => {
    let loadedVideos: SlimVideo[] = [];
    let loadedNextIds: Partial<Record<Platform, string>> = {};
    let videosOk = false;
    let configOk = false;

    function resolve() {
      if (!videosOk || !configOk) return;
      setLoading(false);
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
            platform:    p,
            lastTitle:   cfg.lastPublishedTitle,
            lastDate:    cfg.lastPublishedDate,
            lastVideoId: cfg.lastVideoId,
            intervalDays,
            nextDate:    cfg.lastPublishedDate ? calcNextDate(cfg.lastPublishedDate, intervalDays) : "",
          };
        });
        setSlots(built);
      })
      .catch(() => {})
      .finally(() => { configOk = true; resolve(); });

    syncService.getPublishedVideos()
      .then(data => setPublished(data as PublishedVideo[]))
      .catch(() => {});
  }, []);

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
    } catch {
      // no-op
    } finally {
      setPinning(prev => ({ ...prev, [platform]: false }));
    }
  }

  return (
    <div className="flex flex-col gap-5 pb-4">

      <div>
        <h2 className="text-lg font-semibold text-foreground">Próximas publicaciones</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Navega entre videos · <Pin className="inline w-3 h-3 mb-0.5" /> fija el publicado para reiniciar el conteo ·
          click en "cada Nd" para editar el intervalo
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {slots.map(slot => {
          const currentVideo = videos[indices[slot.platform]];
          return (
            <PlatformCard
              key={slot.platform}
              slot={slot}
              videos={videos}
              index={indices[slot.platform]}
              onOlder={() => navigate(slot.platform, "older")}
              onNewer={() => navigate(slot.platform, "newer")}
              onPin={() => pinVideo(slot.platform)}
              onOpen={() => currentVideo && onOpenVideo?.(currentVideo.fileId, currentVideo.title)}
              onIntervalChange={(days) => updateInterval(slot.platform, days)}
              pinning={pinning[slot.platform]}
              pinned={pinned[slot.platform]}
              loading={loading}
            />
          );
        })}
      </div>

      {/* Último publicado por plataforma */}
      <div className="border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-foreground mb-2">Último publicado</h3>
        <div className="flex flex-col gap-2">
          {(["youtube", "tiktok", "instagram"] as Platform[]).map(p => {
            const data = published.find(d => d.platform === p)
              ?? { platform: p, fileName: null, platformId: null, platformUrl: null, publishedAt: null };
            return <PublishedCard key={p} data={data} />;
          })}
        </div>
      </div>
    </div>
  );
}
