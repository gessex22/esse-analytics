import { useState, useEffect } from "react";
import { Eye, Heart, MessageCircle, Loader2, RefreshCw, BarChart2 } from "lucide-react";
import { syncService, videoService, GroupStatsItem } from "../services/api";
import { YoutubeLogo, InstagramLogo, TiktokLogo, PlatformKey } from "./icons/PlatformLogos";

const PLATFORM_CFG: Record<PlatformKey, { label: string; Logo: (p: { className?: string }) => JSX.Element; light: string; text: string }> = {
  youtube:   { label: "YouTube",   Logo: YoutubeLogo,   light: "bg-red-500/10",    text: "text-red-500"    },
  instagram: { label: "Instagram", Logo: InstagramLogo, light: "bg-purple-500/10", text: "text-purple-500" },
  tiktok:    { label: "TikTok",    Logo: TiktokLogo,    light: "bg-pink-500/10",   text: "text-pink-500"   },
};
const PLATFORMS: PlatformKey[] = ["youtube", "instagram", "tiktok"];

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));
}

function GroupStatsCard({ item, localFileId, onOpenVideo }: {
  item: GroupStatsItem;
  localFileId: string | null;
  onOpenVideo?: (fileId: string, title: string) => void;
}) {
  const totalViews    = PLATFORMS.reduce((sum, p) => sum + (item.platforms[p]?.views ?? 0), 0);
  const totalLikes    = PLATFORMS.reduce((sum, p) => sum + (item.platforms[p]?.likes ?? 0), 0);
  const totalComments = PLATFORMS.reduce((sum, p) => sum + (item.platforms[p]?.comments ?? 0), 0);
  const canPreview = !!localFileId;

  return (
    <div className="p-4 rounded-2xl border border-border bg-card space-y-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => canPreview && onOpenVideo?.(localFileId!, item.fileName)}
          disabled={!canPreview || !onOpenVideo}
          title={canPreview ? "Ver video" : "No se encontró el archivo local"}
          className="w-11 h-14 rounded-lg overflow-hidden bg-black flex-shrink-0 disabled:cursor-default"
        >
          {canPreview && (
            <img
              src={videoService.thumbnailUrl(localFileId!)}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
            />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground truncate" title={item.fileName}>{item.fileName}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{formatDate(item.fecha_creacion)}</p>
          <div className="flex items-center gap-3 mt-1">
            <span className="flex items-center gap-1 text-xs font-semibold text-foreground">
              <Eye className="w-3.5 h-3.5 text-muted-foreground" /> {formatNum(totalViews)}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Heart className="w-3.5 h-3.5" /> {formatNum(totalLikes)}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <MessageCircle className="w-3.5 h-3.5" /> {formatNum(totalComments)}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {PLATFORMS.map(p => {
          const slot = item.platforms[p];
          const cfg  = PLATFORM_CFG[p];
          const Logo = cfg.Logo;
          if (!slot) return null;
          return (
            <div key={p} className={`flex items-center gap-2 rounded-xl px-2.5 py-2 ${cfg.light}`}>
              <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${cfg.text}`}>
                <Logo className="w-4 h-4" />
              </div>
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <span className="flex items-center gap-1 text-xs text-foreground">
                  <Eye className="w-3 h-3 text-muted-foreground flex-shrink-0" /> {formatNum(slot.views)}
                </span>
                <span className="flex items-center gap-1 text-xs text-foreground">
                  <Heart className="w-3 h-3 text-muted-foreground flex-shrink-0" /> {formatNum(slot.likes)}
                </span>
                <span className="flex items-center gap-1 text-xs text-foreground">
                  <MessageCircle className="w-3 h-3 text-muted-foreground flex-shrink-0" /> {formatNum(slot.comments)}
                </span>
              </div>
              {slot.platformUrl && (
                <a href={slot.platformUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-primary hover:underline flex-shrink-0">
                  Ver
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Estadísticas grupales — misma vista para modo simple y avanzado (el matching
// entre plataformas es siempre por archivo, no depende de workflow_mode). Solo
// muestra los últimos videos que ya tienen las 3 plataformas vinculadas
// (ver Ajustes → Sincronización → "Emparejar entre plataformas" para completar
// los que falten).
export function StatsView({ onOpenVideo }: { onOpenVideo?: (fileId: string, title: string) => void } = {}) {
  const [items, setItems] = useState<GroupStatsItem[]>([]);
  const [localIds, setLocalIds] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await syncService.getGroupStats(5);
      setItems(res.items);
      if (res.items.length > 0) {
        videoService.resolveByNames(res.items.map(i => i.fileName))
          .then(setLocalIds)
          .catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Estadísticas</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Los últimos videos publicados en las 3 redes, comparados lado a lado.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs bg-secondary hover:bg-secondary/80 text-foreground px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Actualizar
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <BarChart2 className="w-8 h-8 text-muted-foreground mx-auto" />
          <p className="text-sm text-foreground font-medium">Todavía no hay videos matcheados en las 3 redes</p>
          <p className="text-xs text-muted-foreground">
            Completá los links en Ajustes → Sincronización → "Emparejar entre plataformas".
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {items.map(item => (
            <GroupStatsCard
              key={item.fileId}
              item={item}
              localFileId={localIds[item.fileName] ?? null}
              onOpenVideo={onOpenVideo}
            />
          ))}
        </div>
      )}
    </div>
  );
}
