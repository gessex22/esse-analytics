import { useEffect, useState, useCallback } from "react";
import { Play, Camera, Music2, Share2, Loader2, History as HistoryIcon, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
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
  deviceId: string | null;
  source: string | null;
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

function sourceLabel(source: string | null, deviceId: string | null): string {
  const labels: Record<string, string> = { pc: "PC", android: "Android", ios: "iPhone/iPad", web: "Web" };
  const label = labels[source ?? ""] ?? source ?? "dispositivo desconocido";
  return deviceId ? `${label} · ${deviceId.slice(0, 8)}` : label;
}

const PAGE_SIZE = 10;

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
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const load = useCallback((platform: HistoryPlatform | "all", page: number) => {
    setLoading(true);
    setError(null);
    syncService.getHistory({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, platform: platform === "all" ? undefined : platform })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
        setCurrentPage(page);
      })
      .catch((err) => setError(err?.message || "No se pudo cargar el historial."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(filter, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Historial de subidas</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Cada video que se sube desde la app queda registrado acá automáticamente.
        </p>
        {!loading && total > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            {total} registros · página {currentPage}/{totalPages}
          </p>
        )}
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
                    <span className="ml-1.5">· {sourceLabel(item.source, item.deviceId)}</span>
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

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                onClick={() => load(filter, currentPage - 1)}
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
                        onClick={() => load(filter, item as number)}
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
                onClick={() => load(filter, currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
