import { useEffect, useState, useCallback } from "react";
import { Play, Camera, Music2, Share2, Loader2, History as HistoryIcon, ExternalLink } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { syncService, videoService } from "../services/api";

type HistoryPlatform = "youtube" | "tiktok" | "instagram" | "facebook";

type HistoryItem = {
  id: number;
  platform: string;
  platformId: string;
  platformUrl: string | null;
  publishedAt: string;
  title: string | null;
  fileName: string | null;
  linkedFileId: number | null;
  matchStatus: string;
};

const PLATFORM_CFG: Record<HistoryPlatform, { label: string; icon: LucideIcon; text: string; light: string; bg: string }> = {
  youtube:   { label: "YouTube",   icon: Play,     text: "text-red-500",    light: "bg-red-500/10",    bg: "bg-red-500"    },
  tiktok:    { label: "TikTok",    icon: Music2,   text: "text-pink-500",   light: "bg-pink-500/10",   bg: "bg-pink-500"   },
  instagram: { label: "Instagram", icon: Camera,   text: "text-purple-500", light: "bg-purple-500/10", bg: "bg-purple-500" },
  facebook:  { label: "Facebook",  icon: Share2,   text: "text-blue-500",   light: "bg-blue-500/10",   bg: "bg-blue-500"   },
};

const FILTERS: { value: HistoryPlatform | "all"; label: string }[] = [
  { value: "all",       label: "Todos"     },
  { value: "youtube",   label: "YouTube"   },
  { value: "tiktok",    label: "TikTok"    },
  { value: "instagram", label: "Instagram" },
  { value: "facebook",  label: "Facebook"  },
];

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const PAGE_SIZE = 30;

// Miniatura real del archivo local (ffmpeg, vía videoService) si el upload quedó
// vinculado; si no hay archivo o el thumbnail falla (video borrado del disco,
// aún sin generar, etc.) cae al logo de la plataforma como antes.
function HistoryThumb({ fileId, cfg, Icon }: {
  fileId: number | null;
  cfg?: { bg: string };
  Icon: LucideIcon;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = !!fileId && !failed;

  return (
    <div className={`w-10 h-10 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0 ${showImage ? "bg-black" : (cfg?.bg ?? "bg-secondary")}`}>
      {showImage ? (
        <img
          src={videoService.thumbnailUrl(String(fileId))}
          alt=""
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon className="w-4 h-4 text-white" />
      )}
    </div>
  );
}

interface HistoryViewProps {
  onOpenVideo?: (fileId: string, title: string) => void;
}

export function HistoryView({ onOpenVideo }: HistoryViewProps) {
  const [filter, setFilter]     = useState<HistoryPlatform | "all">("all");
  const [items, setItems]       = useState<HistoryItem[]>([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const load = useCallback((platform: HistoryPlatform | "all", offset: number, append: boolean) => {
    (append ? setLoadingMore : setLoading)(true);
    setError(null);
    syncService.getHistory({ limit: PAGE_SIZE, offset, platform: platform === "all" ? undefined : platform })
      .then((res) => {
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setTotal(res.total);
      })
      .catch((err) => setError(err?.message || "No se pudo cargar el historial."))
      .finally(() => (append ? setLoadingMore : setLoading)(false));
  }, []);

  useEffect(() => {
    load(filter, 0, false);
  }, [filter, load]);

  const canLoadMore = items.length < total;

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Historial de subidas</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Cada video que se sube desde la app queda registrado acá automáticamente.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              filter === value
                ? "bg-primary text-primary-foreground"
                : "bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Cargando historial…
        </div>
      ) : error ? (
        <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/10 text-red-400 text-sm">{error}</div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <HistoryIcon className="w-8 h-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Todavía no hay subidas registradas.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => {
            const cfg = PLATFORM_CFG[item.platform as HistoryPlatform];
            const Icon = cfg?.icon ?? HistoryIcon;
            const clickable = !!(item.linkedFileId && onOpenVideo);
            return (
              <div
                key={`${item.platform}-${item.id}`}
                onClick={clickable ? () => onOpenVideo!(String(item.linkedFileId), item.fileName || item.title || "") : undefined}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-card ${clickable ? "cursor-pointer hover:bg-secondary/40 transition-colors" : ""}`}
              >
                <HistoryThumb fileId={item.linkedFileId} cfg={cfg} Icon={Icon} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate" title={item.fileName || item.title || ""}>
                    {item.fileName || item.title || "Sin título"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {cfg?.label ?? item.platform} · {formatDateTime(item.publishedAt)}
                    {!item.linkedFileId && <span className="ml-1.5 text-amber-500/80">· sin archivo local vinculado</span>}
                  </p>
                </div>
                {item.platformUrl && (
                  <a
                    href={item.platformUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 text-xs text-primary hover:underline flex-shrink-0"
                  >
                    Ver <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            );
          })}

          {canLoadMore && (
            <button
              onClick={() => load(filter, items.length, true)}
              disabled={loadingMore}
              className="mt-2 self-center px-4 py-2 rounded-lg text-sm bg-secondary/50 text-foreground hover:bg-secondary transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Cargar más
            </button>
          )}
        </div>
      )}
    </div>
  );
}
