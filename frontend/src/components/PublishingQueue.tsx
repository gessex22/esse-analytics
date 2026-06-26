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
    day: "numeric", month: "short", year: "numeric",
  });
}

function daysLabel(nextDate: string): string {
  const today = todayStr();
  if (nextDate < today) {
    const diff = Math.round(
      (new Date(today + "T00:00:00").getTime() - new Date(nextDate + "T00:00:00").getTime()) / 86400000,
    );
    return `Venció hace ${diff} día${diff !== 1 ? "s" : ""}`;
  }
  if (nextDate === today) return "Hoy";
  const diff = Math.round(
    (new Date(nextDate + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000,
  );
  return `En ${diff} día${diff !== 1 ? "s" : ""}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function UrgencyPill({ urgency, nextDate, onEdit }: { urgency: Urgency; nextDate: string; onEdit?: () => void }) {
  const label = daysLabel(nextDate);
  const styles: Record<Urgency, string> = {
    past:  "bg-red-500/15 text-red-500",
    today: "bg-orange-500/15 text-orange-500",
    soon:  "bg-amber-400/15 text-amber-600",
    ok:    "bg-secondary text-muted-foreground",
  };
  const Icon = urgency === "past" ? AlertTriangle : Clock;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${styles[urgency]}`}>
      <Icon className="w-3 h-3" />
      {label}
      {onEdit && (
        <button
          onClick={onEdit}
          title="Editar intervalo"
          className="ml-0.5 -mr-0.5 p-0.5 rounded-full hover:bg-black/10 transition-colors"
        >
          <Pencil className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

function VideoSwitcher({
  videos,
  index,
  onOlder,
  onNewer,
  onPin,
  onOpen,
  pinning,
  pinned,
}: {
  videos: SlimVideo[];
  index: number;
  onOlder: () => void;
  onNewer: () => void;
  onPin: () => void;
  onOpen: () => void;
  pinning: boolean;
  pinned: boolean;
}) {
  if (videos.length === 0) {
    return (
      <div className="p-3 rounded-xl border border-dashed border-border text-center">
        <p className="text-sm text-muted-foreground">Sin videos disponibles</p>
      </div>
    );
  }

  const video = videos[index];

  return (
    <div className="flex flex-col gap-2">
      {/* Navegador: ← más viejo · más reciente → */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOlder}
          disabled={index === videos.length - 1}
          className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0 px-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate flex-1">{video.title}</p>
            <button
              onClick={onOpen}
              title="Ver video"
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
            >
              <Clapperboard className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{video.duration}</p>
        </div>

        <button
          onClick={onNewer}
          disabled={index === 0}
          className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Contador + Fijar */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {index + 1} / {videos.length}
        </span>
        <button
          onClick={onPin}
          disabled={pinning || pinned}
          className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
            pinned
              ? "bg-emerald-500/15 text-emerald-600 cursor-default"
              : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          }`}
        >
          {pinning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : pinned ? (
            <Check className="w-3 h-3" />
          ) : (
            <Pin className="w-3 h-3" />
          )}
          {pinned ? "Fijado" : "Fijar como publicado"}
        </button>
      </div>
    </div>
  );
}

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

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex flex-col gap-4 p-5 rounded-2xl border bg-card ${
        urgency === "past"  ? "border-red-500/30 shadow-[0_0_0_1px_rgba(239,68,68,0.12)]"     :
        urgency === "today" ? "border-orange-500/30 shadow-[0_0_0_1px_rgba(249,115,22,0.12)]" :
        "border-border"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{cfg.label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Cada {slot.intervalDays} días</p>
        </div>
        {slot.nextDate && (
          editingInterval ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-foreground flex-shrink-0">
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
                className="w-8 text-center bg-transparent border-b border-dashed border-muted-foreground/50 focus:border-primary focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              días
            </span>
          ) : (
            <UrgencyPill urgency={urgency} nextDate={slot.nextDate} onEdit={() => setEditingInterval(true)} />
          )
        )}
      </div>

      {/* Próxima publicación */}
      <div className="flex flex-col gap-2">
        <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground">
          Próxima · {slot.nextDate ? formatDate(slot.nextDate) : "—"}
        </p>

        {loading ? (
          <div className="flex items-center gap-2 p-3 rounded-xl border border-border bg-secondary/30">
            <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            <span className="text-sm text-muted-foreground">Cargando videos…</span>
          </div>
        ) : (
          <VideoSwitcher
            videos={videos}
            index={index}
            onOlder={onOlder}
            onNewer={onNewer}
            onPin={onPin}
            onOpen={onOpen}
            pinning={pinning}
            pinned={pinned}
          />
        )}
      </div>
    </motion.div>
  );
}

// ── Published videos (bottom section) ─────────────────────────────────────────

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
  return d.toLocaleString("es", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function PublishedCard({ data }: { data: PublishedVideo }) {
  const cfg  = PLATFORM_CFG[data.platform];
  const Icon = cfg.icon;
  const empty = !data.platformId;

  const getStatusBadgeColor = (status?: string): string => {
    if (!status) return "bg-gray-500/20 text-gray-400";
    const s = status.toLowerCase();
    if (s === "publish_complete" || s === "published") return "bg-emerald-500/20 text-emerald-300";
    if (s === "processing_upload" || s === "processing") return "bg-amber-500/20 text-amber-300";
    if (s === "failed") return "bg-red-500/20 text-red-300";
    return "bg-blue-500/20 text-blue-300";
  };

  const formatStats = (stats?: Record<string, any>, platform?: string): { label: string; value: string }[] => {
    if (!stats) return [];
    const items: { label: string; value: string }[] = [];

    if (platform === 'youtube') {
      if (stats.viewCount) items.push({ label: 'Vistas', value: parseInt(stats.viewCount).toLocaleString() });
      if (stats.likeCount) items.push({ label: 'Likes', value: parseInt(stats.likeCount).toLocaleString() });
      if (stats.commentCount) items.push({ label: 'Comentarios', value: parseInt(stats.commentCount).toLocaleString() });
    } else if (platform === 'instagram') {
      if (stats.engagement) items.push({ label: 'Engagement', value: parseInt(stats.engagement).toLocaleString() });
      if (stats.likes) items.push({ label: 'Impresiones', value: parseInt(stats.likes).toLocaleString() });
      if (stats.media_type) items.push({ label: 'Tipo', value: stats.media_type });
    } else if (platform === 'tiktok') {
      if (stats.views) items.push({ label: 'Vistas', value: parseInt(stats.views).toLocaleString() });
      if (stats.likes) items.push({ label: 'Likes', value: parseInt(stats.likes).toLocaleString() });
      if (stats.comments) items.push({ label: 'Comentarios', value: parseInt(stats.comments).toLocaleString() });
      if (stats.shares) items.push({ label: 'Shares', value: parseInt(stats.shares).toLocaleString() });
    }

    return items;
  };

  return (
    <div className="flex flex-col gap-3 p-5 rounded-2xl border border-border bg-card">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
          <Icon className="w-4.5 h-4.5 text-white" />
        </div>
        <p className="text-sm font-semibold text-foreground">{cfg.label}</p>
      </div>

      {empty ? (
        <div className="p-3 rounded-xl border border-dashed border-border text-center">
          <p className="text-sm text-muted-foreground">Sin publicaciones todavía</p>
        </div>
      ) : (
        <>
          {/* Miniatura */}
          {data.stats?.thumbnail && (
            <div className="rounded-lg overflow-hidden bg-black">
              <img src={data.stats.thumbnail} alt="thumbnail" className="w-full h-auto object-cover max-h-48" />
            </div>
          )}

          {/* Archivo local */}
          <div>
            <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground mb-0.5">
              Archivo local
            </p>
            <p className="text-sm font-semibold text-foreground break-words truncate" title={data.fileName || ""}>
              {data.fileName || "— (archivo no encontrado)"}
            </p>
          </div>

          {/* Descripción (limitada) */}
          {data.stats?.description && (
            <div>
              <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground mb-0.5">
                Descripción
              </p>
              <p className="text-xs text-muted-foreground line-clamp-2" title={data.stats.description}>
                {data.stats.description.substring(0, 120)}{data.stats.description.length > 120 ? '...' : ''}
              </p>
            </div>
          )}

          {/* Título del video (si está disponible, no en TikTok) */}
          {data.title && data.platform !== 'tiktok' && (
            <div>
              <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground mb-0.5">
                Título
              </p>
              <p className="text-sm text-foreground break-words line-clamp-2">
                {data.title}
              </p>
            </div>
          )}

          {/* Video publicado */}
          <div className={`rounded-xl p-3 ${cfg.light} flex flex-col gap-2`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground">
                Estado
              </p>
              {data.status && (
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${getStatusBadgeColor(data.status)}`}>
                  {data.status}
                </span>
              )}
            </div>

            {/* Stats Grid */}
            {data.stats && formatStats(data.stats, data.platform).length > 0 && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                {formatStats(data.stats, data.platform).map((item, i) => (
                  <div key={i} className="flex items-center justify-between px-2 py-1.5 rounded-md bg-black/20">
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="font-semibold text-foreground">{item.value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Platform URL (no en TikTok) */}
            {data.platformUrl && data.platform !== 'tiktok' && (
              <p className="text-xs text-muted-foreground">
                <a href={data.platformUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
                  Ver en {cfg.label}
                </a>
              </p>
            )}

            <p className={`text-xs mt-0.5 ${cfg.text}`}>
              Publicado · {formatPublishedAt(data.publishedAt)}
            </p>
          </div>
        </>
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
    // Carga en paralelo; ambas deben completarse para resolver los índices
    let loadedVideos: SlimVideo[] = [];
    let loadedNextIds: Partial<Record<Platform, string>> = {};
    let videosOk = false;
    let configOk = false;

    function resolve() {
      if (!videosOk || !configOk) return;
      setLoading(false);
      // Restaurar la posición guardada por plataforma
      const idx: Record<Platform, number> = { tiktok: 0, instagram: 0, youtube: 0 };
      for (const p of ["tiktok", "instagram", "youtube"] as Platform[]) {
        const id = loadedNextIds[p];
        if (!id) continue;
        // Intenta por fileId primero (web usa MongoDB ObjectId), luego por title (app usa file_name)
        let found = loadedVideos.findIndex(v => v.fileId === id);
        if (found === -1) found = loadedVideos.findIndex(v => v.title === id);
        if (found !== -1) idx[p] = found;
      }
      setIndices(idx);
    }

    // Endpoint ligero: solo fileId + title + duration, sin joins ni transcripciones
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

    // Sección inferior: último video publicado por plataforma (independiente)
    syncService.getPublishedVideos()
      .then(data => setPublished(data as PublishedVideo[]))
      .catch(() => {});
  }, []);

  // Cambiar el intervalo de días de una plataforma (optimista + persiste en backend)
  function updateInterval(platform: Platform, days: number) {
    if (!Number.isFinite(days) || days < 1) return;
    setSlots(prev => prev.map(s =>
      s.platform === platform
        ? { ...s, intervalDays: days, nextDate: s.lastDate ? calcNextDate(s.lastDate, days) : s.nextDate }
        : s
    ));
    syncService.updateCalendarConfig(platform, { intervalDays: days }).catch(() => {});
  }

  // Navegación local — sin auto-guardado; Pin es el único punto de guardado
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

    // El "próximo" es el video más reciente adyacente (índice -1)
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
      // No-op — usuario puede reintentar
    } finally {
      setPinning(prev => ({ ...prev, [platform]: false }));
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-4">

      <div>
        <h2 className="text-lg font-semibold text-foreground">Próximas publicaciones</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Navega entre los videos y fija el que publicaste para reiniciar el conteo
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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

      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground border-t border-border pt-4">
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
          Slot vencido
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-orange-500" />
          Publica hoy
        </span>
        <span className="flex items-center gap-1.5">
          <Pin className="w-3.5 h-3.5" />
          Fijar actualiza el contador desde hoy
        </span>
      </div>

      {/* Último video publicado por plataforma */}
      <div className="border-t border-border pt-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-foreground">Último video publicado</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Archivo local y datos de la publicación real en cada plataforma
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
