import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronRight,
  Eye,
  Heart,
  MessageCircle,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Video,
} from "lucide-react";
import {
  syncService,
  videoService,
  setupService,
  GroupStatsItem,
  WorkflowMode,
} from "../services/api";
import {
  InstagramLogo,
  TiktokLogo,
  YoutubeLogo,
} from "./icons/PlatformLogos";
import { calcNextDate } from "../data/mockPublishingData";

type Platform = "youtube" | "instagram" | "tiktok";
type HistoryItem = Awaited<
  ReturnType<typeof syncService.getHistory>
>["items"][number];
type PlatformCfg = {
  label: string;
  Logo: (props: { className?: string }) => JSX.Element;
  color: string;
  soft: string;
};

const PLATFORM_CFG: Record<Platform, PlatformCfg> = {
  youtube: {
    label: "YouTube",
    Logo: YoutubeLogo,
    color: "text-red-400",
    soft: "bg-red-500/10",
  },
  instagram: {
    label: "Instagram",
    Logo: InstagramLogo,
    color: "text-purple-400",
    soft: "bg-purple-500/10",
  },
  tiktok: {
    label: "TikTok",
    Logo: TiktokLogo,
    color: "text-pink-400",
    soft: "bg-pink-500/10",
  },
};
const PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

const DEMO_ITEM: GroupStatsItem = {
  fileId: "demo",
  fileName: "Cómo crear contenido que sí convierte",
  fecha_creacion: new Date().toISOString(),
  platforms: {
    youtube: {
      platformId: "demo-youtube",
      platformUrl: "#",
      title: "Cómo crear contenido que sí convierte",
      thumbnail: "",
      views: 12400,
      likes: 840,
      comments: 63,
    },
    instagram: {
      platformId: "demo-instagram",
      platformUrl: "#",
      title: "Cómo crear contenido que sí convierte",
      thumbnail: "",
      views: 8200,
      likes: 612,
      comments: 41,
    },
    tiktok: {
      platformId: "demo-tiktok",
      platformUrl: "#",
      title: "Cómo crear contenido que sí convierte",
      thumbnail: "",
      views: 21700,
      likes: 1900,
      comments: 118,
    },
  },
};

// "Próximo" acá NO es una fecha fija guardada en el archivo (scheduled_date
// nunca se usa en la práctica) -- es la misma proyección que ya calcula
// Calendario (PublishingQueue.tsx): última publicada + intervalo de días,
// por plataforma. Antes esta tarjeta filtraba /api/calendar por scheduled_date
// y quedaba vacía para siempre porque ese campo nunca se completa.
type UpcomingSlot = {
  platform: Platform;
  title: string;
  date: string;
  fileId: string;
};

const DEMO_CALENDAR: UpcomingSlot[] = [
  { platform: "youtube", title: "3 errores al publicar", date: calcNextDate(new Date().toISOString().slice(0, 10), 1), fileId: "demo-1" },
  { platform: "instagram", title: "La fórmula del hook", date: calcNextDate(new Date().toISOString().slice(0, 10), 2), fileId: "demo-2" },
  { platform: "tiktok", title: "Ideas para esta semana", date: calcNextDate(new Date().toISOString().slice(0, 10), 4), fileId: "demo-3" },
];

function formatNum(value: number) {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(".0", "")}K`;
  return String(value);
}

function formatDate(value: string | Date) {
  return new Intl.DateTimeFormat("es", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(typeof value === "string" ? new Date(value) : value);
}

function PlatformRow({
  platform,
  stats,
}: {
  platform: Platform;
  stats?: { views: number; likes: number; comments: number };
}) {
  const cfg = PLATFORM_CFG[platform];
  const Logo = cfg.Logo;
  const hasStats = Boolean(stats);
  return (
    <div
      className={`flex items-center gap-3 rounded-xl px-3 ${"py-2.5"} ${cfg.soft}`}
    >
      <Logo className={`w-4 h-4 flex-shrink-0 ${cfg.color}`} />
      <span className="text-xs font-medium text-foreground w-20">
        {cfg.label}
      </span>
      <div className="flex items-center gap-3 text-xs text-muted-foreground ml-auto">
        {hasStats ? (
          <>
            <span className="flex items-center gap-1">
              <Eye className="w-3 h-3" />
              {formatNum(stats?.views ?? 0)}
            </span>
            <span className="flex items-center gap-1">
              <Heart className="w-3 h-3" />
              {formatNum(stats?.likes ?? 0)}
            </span>
            <span className="flex items-center gap-1">
              <MessageCircle className="w-3 h-3" />
              {formatNum(stats?.comments ?? 0)}
            </span>
          </>
        ) : (
          <span className="text-[11px]">Pendiente de datos</span>
        )}
      </div>
    </div>
  );
}

function PodiumGadget({
  ranking,
  demoMode,
}: {
  ranking: { platform: Platform; views: number; videos: number }[];
  demoMode: boolean;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Plataforma líder
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Podio de vistas recientes
          </p>
        </div>
        <TrendingUp className="w-4 h-4 text-primary" />
      </div>
      <div className="flex items-end justify-center gap-3 py-2">
        {ranking.slice(0, 3).map((entry, index) => {
          const cfg = PLATFORM_CFG[entry.platform];
          const Logo = cfg.Logo;
          return (
            <div
              key={entry.platform}
              className={`flex flex-col items-center text-center ${index > 0 ? "opacity-80" : ""}`}
            >
              <div
                className={`${index === 0 ? "w-12 h-12 rounded-2xl" : "w-9 h-9 rounded-xl"} ${cfg.soft} flex items-center justify-center mb-2`}
              >
                <Logo
                  className={`${index === 0 ? "w-5 h-5" : "w-4 h-4"} ${cfg.color}`}
                />
              </div>
              <span
                className={`${index === 0 ? "text-[11px] font-semibold" : "text-[10px] font-medium"} text-foreground`}
              >
                {index + 1}º {cfg.label}
              </span>
              <span
                className={`${index === 0 ? "text-lg" : "text-sm"} font-semibold text-foreground`}
              >
                {formatNum(entry.views)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Comparativa reciente</span>
        <span>{demoMode ? "Demo" : "Actualizado"}</span>
      </div>
    </section>
  );
}

export function DashboardView({
  onOpenVideo,
  onOpenCalendar,
}: {
  onOpenVideo?: (fileId: string, title: string) => void;
  onOpenCalendar?: () => void;
}) {
  const [items, setItems] = useState<GroupStatsItem[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingSlot[]>([]);
  const [latestHistory, setLatestHistory] = useState<HistoryItem | null>(null);
  const [fallbackStats, setFallbackStats] = useState<GroupStatsItem | null>(null);
  const [localFileId, setLocalFileId] = useState<string | null>(null);
  const [localThumbnailFailed, setLocalThumbnailFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  // 'simple' cross-postea a las 3 a la vez, así que combinar sus métricas en
  // la tarjeta tiene sentido -- 'avanzado' publica plataforma por plataforma,
  // y mostrar siempre las 3 sumadas sin decir cuál se publicó de verdad
  // confundía (ver historyPlatform, más abajo).
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode | null>(null);
  useEffect(() => {
    setupService.getWorkflowMode().then(d => setWorkflowMode(d.workflowMode)).catch(() => {});
  }, []);
  const isSimpleFlow = workflowMode === "simple";

  const load = async () => {
    setLoading(true);
    try {
      const [stats, calendarConfig, history] = await Promise.all([
        syncService.getGroupStats(5),
        syncService.getCalendarConfig(),
        syncService.getHistory({ limit: 1 }),
      ]);
      setItems(stats.items);
      setUpcoming(
        calendarConfig
          .filter(
            (cfg): cfg is typeof cfg & { nextVideo: NonNullable<typeof cfg.nextVideo> } =>
              PLATFORMS.includes(cfg.platform as Platform) && !!cfg.nextVideo,
          )
          .map((cfg) => ({
            platform: cfg.platform as Platform,
            title: cfg.nextVideo.title,
            fileId: cfg.nextVideo.fileId,
            date: cfg.lastPublishedDate
              ? calcNextDate(cfg.lastPublishedDate.slice(0, 10), cfg.intervalDays)
              : new Date().toISOString().slice(0, 10),
          }))
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(0, 3),
      );
      setLatestHistory(history.items[0] ?? null);
      setDemoMode(stats.items.length === 0 && history.items.length === 0);
    } catch {
      setItems([]);
      setUpcoming([]);
      setLatestHistory(null);
      setDemoMode(true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const historyPlatform =
    latestHistory && PLATFORMS.includes(latestHistory.platform as Platform)
      ? (latestHistory.platform as Platform)
      : null;
  const matchedHistoryItem = latestHistory?.fileName
    ? items.find((entry) => entry.fileName === latestHistory.fileName)
    : undefined;
  const matchedHistoryByFileId =
    latestHistory?.linkedFileId != null
      ? items.find(
          (entry) => entry.fileId === String(latestHistory.linkedFileId),
        )
      : undefined;
  const matchedHistoryByPlatform = historyPlatform
    ? items.find(
        (entry) =>
          entry.platforms[historyPlatform]?.platformId ===
          latestHistory?.platformId,
      )
    : undefined;
  const matchedHistory =
    matchedHistoryItem ?? matchedHistoryByFileId ?? matchedHistoryByPlatform;

  // El último video publicado puede no estar todavía cross-posteado a las 3
  // redes (getGroupStats solo trae los que sí lo están, para la comparación
  // de Estadísticas) -- si no aparece ahí, se piden sus stats puntuales en
  // vez de mostrar el card sin ninguna métrica.
  useEffect(() => {
    if (demoMode || !latestHistory || matchedHistory) {
      setFallbackStats(null);
      return;
    }
    const fileId =
      latestHistory.linkedFileId != null &&
      /^[a-f0-9]{24}$/i.test(String(latestHistory.linkedFileId))
        ? String(latestHistory.linkedFileId)
        : undefined;
    const fileName = latestHistory.fileName ?? undefined;
    if (!fileId && !fileName) {
      setFallbackStats(null);
      return;
    }
    let cancelled = false;
    syncService
      .getFileStats({ fileId, fileName })
      .then((stats) => {
        if (!cancelled) setFallbackStats(stats);
      })
      .catch(() => {
        if (!cancelled) setFallbackStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [demoMode, latestHistory, matchedHistory]);

  const item = demoMode
    ? DEMO_ITEM
    : latestHistory
      ? (matchedHistory ??
        fallbackStats ?? {
          fileId: String(latestHistory.id),
          fileName:
            latestHistory.fileName ??
            latestHistory.title ??
            "Última publicación",
          fecha_creacion: latestHistory.publishedAt,
          platforms: {},
        })
      : items[0];

  // El fileId de `item` viene de la central (Mongo _id) -- la miniatura y el
  // player son locales (SQLite), así que hace falta resolver el id local por
  // fileName antes de poder pedirlos (mismo patrón que StatsView.tsx).
  const itemFileName = item && item.fileId !== "demo" ? item.fileName : null;
  useEffect(() => {
    if (!itemFileName) {
      setLocalFileId(null);
      return;
    }
    let cancelled = false;
    videoService
      .resolveByNames([itemFileName])
      .then((map) => {
        if (!cancelled) setLocalFileId(map[itemFileName] ?? null);
      })
      .catch(() => {
        if (!cancelled) setLocalFileId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [itemFileName]);
  useEffect(() => {
    setLocalThumbnailFailed(false);
  }, [localFileId]);

  // Si el video no está en el catálogo local de esta PC (publicado desde el
  // celular, o los bytes locales se borraron) no hay miniatura ffmpeg posible
  // -- se cae a la miniatura propia de la plataforma (YouTube/Instagram/
  // TikTok), que siempre viaja en el registro aunque el archivo físico no
  // esté acá.
  const platformThumbnail = item
    ? PLATFORMS.map((p) => item.platforms[p]?.thumbnail).find((t) => !!t)
    : undefined;

  const calendar = demoMode ? DEMO_CALENDAR : upcoming;
  const totals = useMemo(
    () =>
      PLATFORMS.reduce(
        (acc, platform) => {
          const stats = item?.platforms[platform];
          acc.views += stats?.views ?? 0;
          acc.likes += stats?.likes ?? 0;
          acc.comments += stats?.comments ?? 0;
          return acc;
        },
        { views: 0, likes: 0, comments: 0 },
      ),
    [item],
  );
  // En modo avanzado, "último publicado" debe mostrar la plataforma real a
  // la que se subió (historyPlatform) y sus métricas puntuales -- no las 3
  // plataformas sumadas, que puede incluir datos de matches viejos sin
  // relación con esta subida puntual.
  const focusPlatform =
    !isSimpleFlow && !demoMode ? historyPlatform : null;
  const focusStats = focusPlatform ? item?.platforms[focusPlatform] : undefined;
  const displayTotals = focusStats ?? totals;
  const ranking = useMemo(() => {
    const source = demoMode ? [DEMO_ITEM] : items;
    return PLATFORMS.map((platform) => {
      const values = source
        .map((entry) => entry.platforms[platform])
        .filter(Boolean) as {
        views: number;
        likes: number;
        comments: number;
      }[];
      const views = values.reduce((sum, value) => sum + value.views, 0);
      const likes = values.reduce((sum, value) => sum + value.likes, 0);
      const comments = values.reduce((sum, value) => sum + value.comments, 0);
      return {
        platform,
        views,
        engagement: views ? ((likes + comments) / views) * 100 : 0,
        videos: values.length,
      };
    }).sort((a, b) => b.views - a.views);
  }, [demoMode, items]);
  const LeaderLogo = ranking[0] ? PLATFORM_CFG[ranking[0].platform].Logo : null;

  return (
    <div className="space-y-5 max-w-5xl">
      <style>{`.dashboard-top-grid > section:nth-child(3) { display: none; }
        .dashboard-top-grid > section:nth-child(1) > div:nth-child(2) > div:nth-child(1) { order: 2; transform: translateY(-0.5rem); }
        .dashboard-top-grid > section:nth-child(1) > div:nth-child(2) > div:nth-child(2) { order: 1; }
        .dashboard-top-grid > section:nth-child(1) > div:nth-child(2) > div:nth-child(3) { order: 3; }
        .dashboard-top-grid > section:nth-child(1) { order: 2; }
        .dashboard-top-grid > section:nth-child(2) { order: 1; }
        @media (min-width: 640px) {
        [class~="sm:grid-cols-[0.9fr_1.1fr]"] { grid-template-columns: 1.15fr 0.85fr !important; }
        [class~="max-w-[17rem]"] { max-width: none !important; flex: 1 1 0%; }
        @media (min-width: 1024px) {
          .dashboard-top-grid > section:nth-child(3) { display: none; }
          .dashboard-top-grid > section:nth-child(1) { order: 2; }
          .dashboard-top-grid > section:nth-child(2) { order: 1; }
        }
      }`}</style>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-primary font-semibold">
            Centro de control
          </p>
          <h1 className="text-2xl font-semibold text-foreground mt-1">
            Resumen
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Una mirada rápida a tu contenido publicado y lo que viene.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-2 text-xs text-foreground hover:bg-secondary/80 disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Actualizar
        </button>
      </div>

      {demoMode && (
        <div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
          <Sparkles className="w-3.5 h-3.5" />
          Vista previa de demo: estos datos aparecerán reemplazados por tus
          métricas reales.
        </div>
      )}

      <div className="dashboard-top-grid grid grid-cols-1 lg:grid-cols-[1.35fr_0.65fr] gap-4 items-stretch">
        <PodiumGadget ranking={ranking} demoMode={demoMode} />
        <section className="rounded-2xl border border-border bg-card p-4 sm:p-6">
          <div className="flex items-center mb-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Último video publicado
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {focusPlatform
                  ? `Publicado en ${PLATFORM_CFG[focusPlatform].label}`
                  : "Rendimiento comparado entre plataformas"}
              </p>
            </div>
          </div>
          {item ? (
            <div className="grid grid-cols-1 sm:grid-cols-[0.9fr_1.1fr] gap-5 items-center">
              <div className="flex gap-4 min-w-0">
                <button
                  onClick={() =>
                    localFileId && onOpenVideo?.(localFileId, item.fileName)
                  }
                  disabled={!localFileId}
                  className="relative w-24 sm:w-32 h-32 sm:h-44 rounded-xl bg-gradient-to-br from-primary/30 via-secondary to-black overflow-hidden flex-shrink-0 disabled:cursor-default"
                  title={localFileId ? "Abrir video" : "No se encontró el archivo local"}
                >
                  {(() => {
                    // La miniatura local (ffmpeg) se intenta primero si hay
                    // localFileId, pero puede fallar (archivo movido, thumbnail
                    // no generado todavía, etc.) -- ahí SÍ hay que caer a la de
                    // la plataforma en tiempo real, no solo elegir una vez.
                    const useLocal = !!localFileId && !localThumbnailFailed;
                    const src = useLocal
                      ? videoService.thumbnailUrl(localFileId!)
                      : platformThumbnail;
                    if (!src) return null;
                    return (
                      <img
                        src={src}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                        onError={(event) => {
                          if (useLocal && platformThumbnail) {
                            setLocalThumbnailFailed(true);
                          } else {
                            event.currentTarget.style.display = "none";
                          }
                        }}
                      />
                    );
                  })()}
                  <div className="relative h-full flex items-center justify-center">
                    <Video className="w-8 h-8 text-primary/70" />
                  </div>
                </button>
                <div className="min-w-0 max-w-[17rem]">
                  <h3 className="text-base font-semibold text-foreground leading-snug line-clamp-3">
                    {item.fileName}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Publicado {formatDate(item.fecha_creacion)}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 mt-4">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      <Eye className="w-4 h-4 text-muted-foreground" />
                      {formatNum(displayTotals.views)}
                    </span>
                    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Heart className="w-4 h-4" />
                      {formatNum(displayTotals.likes)}
                    </span>
                    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <MessageCircle className="w-4 h-4" />
                      {formatNum(displayTotals.comments)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="space-y-2 min-w-0 self-stretch flex flex-col justify-center">
                {(focusPlatform ? [focusPlatform] : PLATFORMS).map((p) => (
                  <PlatformRow key={p} platform={p} stats={item.platforms[p]} />
                ))}
              </div>
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Todavía no hay publicaciones vinculadas.
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Plataforma líder
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Vistas en los últimos videos
              </p>
            </div>
            <TrendingUp className="w-4 h-4 text-primary" />
          </div>
          {ranking[0] && LeaderLogo && (
            <div className="flex flex-col items-center text-center py-2">
              <div
                className={`w-14 h-14 rounded-2xl ${PLATFORM_CFG[ranking[0].platform].soft} flex items-center justify-center mb-3`}
              >
                <div className="w-10 h-10 rounded-xl bg-card/70 flex items-center justify-center">
                  <LeaderLogo
                    className={`w-5 h-5 ${PLATFORM_CFG[ranking[0].platform].color}`}
                  />
                </div>
              </div>
              <p className="text-sm font-semibold text-foreground">
                {PLATFORM_CFG[ranking[0].platform].label}
              </p>
              <p className="text-2xl font-semibold text-foreground mt-1">
                {formatNum(ranking[0].views)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                vistas · {ranking[0].videos} video
                {ranking[0].videos === 1 ? "" : "s"}
              </p>
            </div>
          )}
          <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Comparativa reciente</span>
            <span>{demoMode ? "Demo" : "Actualizado"}</span>
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-card p-4 sm:p-5 lg:w-[calc(66.666%_-_0.5rem)]">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Próximas publicaciones
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Tu agenda más cercana
            </p>
          </div>
          <CalendarDays className="w-4 h-4 text-primary" />
        </div>
        {calendar.length > 0 ? (
          <div className="space-y-2">
            {calendar.map((video) => {
              // video.date es "YYYY-MM-DD" (calcNextDate) -- parsearlo con
              // new Date(string) lo interpreta como UTC medianoche y puede
              // mostrar el día anterior en husos horarios negativos.
              const [y, m, d] = video.date.split("-").map(Number);
              const localDate = new Date(y, m - 1, d);
              const Logo = PLATFORM_CFG[video.platform].Logo;
              return (
                <div
                  key={`${video.platform}-${video.fileId}`}
                  className="flex items-center gap-3 rounded-xl bg-secondary/40 px-3 py-3"
                >
                  <div className="w-10 text-center flex-shrink-0">
                    <p className="text-[10px] uppercase text-muted-foreground">
                      {formatDate(localDate).split(" ")[0]}
                    </p>
                    <p className="text-lg font-semibold text-foreground leading-none mt-1">
                      {localDate.getDate()}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">
                      {video.title}
                    </p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <Logo className={`w-3 h-3 ${PLATFORM_CFG[video.platform].color}`} />
                    </div>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No hay publicaciones próximas.
          </p>
        )}
        <button
          onClick={onOpenCalendar}
          className="flex items-center gap-1 mt-4 text-xs text-primary hover:underline"
        >
          Abrir calendario <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </section>
    </div>
  );
}
