import { useState, useEffect } from "react";
import { Eye, Heart, MessageCircle, Loader2, RefreshCw, BarChart2 } from "lucide-react";
import { syncService, videoService, GroupStatsItem } from "../services/api";
import { YoutubeLogo, InstagramLogo, TiktokLogo, PlatformKey } from "./icons/PlatformLogos";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

// Mismos colores de marca que ya se usan en toda la app (VideosView, SyncPanel)
// para YouTube/Instagram/TikTok — se reusan acá como identidad categórica del
// donut en vez de una paleta genérica, para que el color siga significando lo
// mismo en cualquier pantalla.
const PLATFORM_CFG: Record<PlatformKey, { label: string; Logo: (p: { className?: string }) => JSX.Element; light: string; text: string; hex: string }> = {
  youtube:   { label: "YouTube",   Logo: YoutubeLogo,   light: "bg-red-500/10",    text: "text-red-500",    hex: "#ef4444" },
  instagram: { label: "Instagram", Logo: InstagramLogo, light: "bg-purple-500/10", text: "text-purple-500", hex: "#a855f7" },
  tiktok:    { label: "TikTok",    Logo: TiktokLogo,    light: "bg-pink-500/10",   text: "text-pink-500",   hex: "#ec4899" },
};
const PLATFORMS: PlatformKey[] = ["youtube", "instagram", "tiktok"];

function statsChartData(items: GroupStatsItem[], platform?: PlatformKey) {
  const sorted = [...items].sort((a, b) => new Date(a.fecha_creacion).getTime() - new Date(b.fecha_creacion).getTime());
  return sorted.map((item, index) => {
    const point: Record<string, string | number> = { video: `V${index + 1}` };
    for (const name of platform ? [platform] : PLATFORMS) {
      point[name] = item.platforms[name]?.views ?? 0;
    }
    return point;
  });
}

function chartMax(items: GroupStatsItem[], platform?: PlatformKey): number {
  const maxValue = items.reduce((max, item) => {
    return Math.max(max, ...(platform ? [platform] : PLATFORMS).map(name => Number(item.platforms[name]?.views ?? 0)));
  }, 0);
  if (maxValue <= 0) return 1;

  // Redondea hacia arriba a una escala legible, pero siempre basada en el
  // máximo real de las tres plataformas. Antes Recharts terminaba mostrando
  // una escala demasiado pequeña (por ejemplo 1.5K cuando había 3K+).
  // Deja aproximadamente 15% de aire sobre la curva antes de redondear el
  // límite a un número legible. Así el punto más alto nunca queda pegado al
  // borde superior del gráfico.
  const paddedValue = maxValue * 1.15;
  const magnitude = 10 ** Math.floor(Math.log10(paddedValue));
  const normalized = paddedValue / magnitude;
  const step = normalized <= 1 ? 0.2 : normalized <= 2 ? 0.5 : normalized <= 5 ? 1 : 2;
  const tickStep = step * magnitude;
  return Math.ceil(paddedValue / tickStep) * tickStep;
}

function StatsChart({ items, platform }: { items: GroupStatsItem[]; platform?: PlatformKey }) {
  const yMax = chartMax(items, platform);
  const visiblePlatforms = platform ? [platform] : PLATFORMS;
  return (
    <div className="p-4 rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground">Vistas por video y plataforma</h3>
        <span className="text-[11px] text-muted-foreground">V1 = más antiguo</span>
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={statsChartData(items, platform)} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="video" tick={{ fontSize: 11 }} />
            <YAxis
              domain={[0, yMax]}
              tick={{ fontSize: 11 }}
              tickFormatter={formatNum}
              width={48}
              allowDecimals={false}
              tickCount={5}
            />
            <Tooltip formatter={(value) => formatNum(Number(value))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {visiblePlatforms.map(name => (
              <Line key={name} type="monotone" dataKey={name} name={PLATFORM_CFG[name].label} stroke={PLATFORM_CFG[name].hex} strokeWidth={2} dot={{ r: 3 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function StatsTotalsCard({ items, platform }: { items: GroupStatsItem[]; platform?: PlatformKey }) {
  const total = (key: "views" | "likes" | "comments") =>
    items.reduce((sum, item) => sum + (platform ? [platform] : PLATFORMS).reduce((subtotal, name) => subtotal + (item.platforms[name]?.[key] ?? 0), 0), 0);

  return (
    <div className="grid grid-cols-3 gap-3 p-4 rounded-2xl border border-border bg-card">
      {[
        [Eye, "Vistas", total("views")],
        [Heart, "Likes", total("likes")],
        [MessageCircle, "Comentarios", total("comments")],
      ].map(([Icon, label, value]) => {
        const MetricIcon = Icon as typeof Eye;
        return (
          <div key={label as string} className="min-w-0">
            <div className="flex items-center gap-1.5 text-foreground">
              <MetricIcon className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-base font-bold truncate">{formatNum(value as number)}</span>
            </div>
            <span className="text-[11px] text-muted-foreground">{label as string}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Donut de alcance (views) ────────────────────────────────────────────────
// Solo views (no likes/comments) — responde "qué plataforma tuvo mayor
// alcance". Anillo fino con separador de 2px entre segmentos (mismo criterio
// que el resto de la app: la barra de progreso ya usa espaciadores, no bordes).
// El centro muestra el logo + % de la plataforma líder — la identidad nunca
// depende solo del color: cada segmento ya comparte tinte con su fila de abajo
// (mismo hex, mismo logo), así que esa lista actúa como leyenda.
function ViewsDonut({ platforms }: { platforms: GroupStatsItem["platforms"] }) {
  const values = PLATFORMS.map(p => ({ p, v: platforms[p]?.views ?? 0 }));
  const total = values.reduce((sum, x) => sum + x.v, 0);

  if (total === 0) {
    return (
      <div className="w-14 h-14 rounded-full border-2 border-dashed border-border flex items-center justify-center flex-shrink-0" title="Todavía sin vistas">
        <Eye className="w-4 h-4 text-muted-foreground/50" />
      </div>
    );
  }

  const R = 26, CENTER = 32, STROKE = 8;
  const circumference = 2 * Math.PI * R;
  const GAP = 3; // separador entre segmentos, en px de arco

  let cursor = 0;
  const segments = values
    .filter(x => x.v > 0)
    .map(({ p, v }) => {
      const frac = v / total;
      const raw  = frac * circumference;
      const dash = Math.max(raw - GAP, 1);
      const seg  = { p, dash, offset: -cursor };
      cursor += raw;
      return seg;
    });

  const leader = values.reduce((a, b) => (b.v > a.v ? b : a));
  const LeaderLogo = PLATFORM_CFG[leader.p].Logo;
  const leaderPct = Math.round((leader.v / total) * 100);

  return (
    <div className="relative w-14 h-14 flex-shrink-0" title={`${PLATFORM_CFG[leader.p].label} lidera con ${leaderPct}% de las vistas`}>
      <svg viewBox="0 0 64 64" className="w-14 h-14 -rotate-90">
        <circle cx={CENTER} cy={CENTER} r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
        {segments.map(seg => (
          <circle
            key={seg.p}
            cx={CENTER} cy={CENTER} r={R}
            fill="none"
            stroke={PLATFORM_CFG[seg.p].hex}
            strokeWidth={STROKE}
            strokeLinecap="butt"
            strokeDasharray={`${seg.dash} ${circumference - seg.dash}`}
            strokeDashoffset={seg.offset}
          />
        ))}
      </svg>
      <div className={`absolute inset-0 flex flex-col items-center justify-center gap-0.5 ${PLATFORM_CFG[leader.p].text}`}>
        <LeaderLogo className="w-3.5 h-3.5" />
        <span className="text-[9px] font-semibold text-foreground leading-none">{leaderPct}%</span>
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));
}

function GroupStatsCard({ item, localFileId, onOpenVideo, platform }: {
  item: GroupStatsItem;
  localFileId: string | null;
  onOpenVideo?: (fileId: string, title: string) => void;
  platform?: PlatformKey;
}) {
  const visiblePlatforms = platform ? [platform] : PLATFORMS;
  const totalViews    = visiblePlatforms.reduce((sum, p) => sum + (item.platforms[p]?.views ?? 0), 0);
  const totalLikes    = visiblePlatforms.reduce((sum, p) => sum + (item.platforms[p]?.likes ?? 0), 0);
  const totalComments = visiblePlatforms.reduce((sum, p) => sum + (item.platforms[p]?.comments ?? 0), 0);
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
        <ViewsDonut platforms={item.platforms} />
      </div>

      <div className="flex flex-col gap-2">
        {visiblePlatforms.map(p => {
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

// Caché a nivel de módulo -- mismo patrón que calendarCache en
// PublishingQueue.tsx. App.tsx navega por índice con un ternario (no hay
// router), así que cambiar de pestaña DESMONTA el componente entero; sin
// esto, cada vez que volvías a Estadísticas arrancaba de cero (items: [],
// loading: true) y se veía el spinner de nuevo aunque los datos ya se
// hubieran cargado hace 5 segundos. Con la caché, el segundo mount arranca
// mostrando lo último que se vio mientras load() refresca en silencio atrás.
interface StatsCache {
  items: GroupStatsItem[];
  localIds: Record<string, string | null>;
}
type StatsFilter = 'all' | PlatformKey;
let statsCache: Partial<Record<StatsFilter, StatsCache>> = {};

// Estadísticas grupales — misma vista para modo simple y avanzado (el matching
// entre plataformas es siempre por archivo, no depende de workflow_mode). La
// pestaña Comparadas exige las 3 plataformas vinculadas; cada pestaña individual
// muestra su propio historial publicado.
export function StatsView({ onOpenVideo }: { onOpenVideo?: (fileId: string, title: string) => void } = {}) {
  const [filter, setFilter] = useState<StatsFilter>('all');
  const [items, setItems] = useState<GroupStatsItem[]>(statsCache.all?.items ?? []);
  const [localIds, setLocalIds] = useState<Record<string, string | null>>(statsCache.all?.localIds ?? {});
  // Solo arranca en loading si no hay nada cacheado todavía -- con caché, el
  // refresco de fondo no debe tapar el contenido ya visible (ver el gate de
  // renderizado más abajo, que ya no depende solo de `loading`).
  const [loading, setLoading] = useState(!statsCache.all);

  const load = async () => {
    const cached = statsCache[filter];
    setItems(cached?.items ?? []);
    setLocalIds(cached?.localIds ?? {});
    setLoading(true);
    try {
      const res = await syncService.getGroupStats(5, filter === 'all' ? undefined : filter);
      setItems(res.items);
      statsCache[filter] = { items: res.items, localIds: cached?.localIds ?? {} };
      if (res.items.length > 0) {
        videoService.resolveByNames(res.items.map(i => i.fileName))
          .then((map) => {
            setLocalIds(map);
            statsCache[filter] = { items: res.items, localIds: map };
          })
          .catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter]);

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Estadísticas</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {filter === 'all' ? 'Los últimos videos publicados en las 3 redes, comparados lado a lado.' : `Los últimos 5 videos publicados en ${PLATFORM_CFG[filter].label}.`}
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

      <div className="flex flex-wrap gap-2" aria-label="Filtrar estadísticas por plataforma">
        {(['all', ...PLATFORMS] as StatsFilter[]).map(option => {
          const active = filter === option;
          const label = option === 'all' ? 'Comparadas' : PLATFORM_CFG[option].label;
          return (
            <button
              key={option}
              onClick={() => setFilter(option)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground hover:bg-secondary/80'}`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Transición CSS pura (opacity), sin Framer Motion -- se probó con
          AnimatePresence y dio dos bugs reales: mode="wait" se trababa con
          StrictMode (dos load() superpuestos dejaban el contenido en
          opacity:0 para siempre) y sin mode="wait" el contenido viejo y el
          nuevo quedaban apilados uno debajo del otro (ninguno de los dos
          estaba con position:absolute). Atenuar in-place, sin desmontar
          nada, evita ambos problemas y ya alcanza para que no se sienta como
          un corte seco al cambiar de pestaña. */}
      <div className={`transition-opacity duration-150 ${loading ? 'opacity-40' : 'opacity-100'}`}>
        {items.length === 0 && !loading ? (
          <div className="text-center py-16 space-y-2">
            <BarChart2 className="w-8 h-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-foreground font-medium">{filter === 'all' ? 'Todavía no hay videos matcheados en las 3 redes' : `Todavía no hay videos publicados en ${PLATFORM_CFG[filter].label}`}</p>
            <p className="text-xs text-muted-foreground">
              {filter === 'all' ? 'Completá los links en Ajustes → Sincronización → "Emparejar entre plataformas".' : 'Publicá un video o sincronizá el historial de esta plataforma.'}
            </p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            <StatsChart items={items} platform={filter === 'all' ? undefined : filter} />
            <StatsTotalsCard items={items} platform={filter === 'all' ? undefined : filter} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {items.map(item => (
              <GroupStatsCard
                key={item.fileId}
                item={item}
                localFileId={localIds[item.fileName] ?? null}
                onOpenVideo={onOpenVideo}
                platform={filter === 'all' ? undefined : filter}
              />
            ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
