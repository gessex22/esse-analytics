import { useState, useEffect, useCallback } from "react";
import { Tv2, Link2, Unlink, ChevronLeft, ChevronRight, RefreshCw, Check, Loader2 } from "lucide-react";
import { videoService, syncService, SyncReviewItem, SyncStats, PlatformRecentItem, CrossMatchCandidate, CrossMatchResolvedSlot } from "../services/api";
import { YoutubeLogo, InstagramLogo, TiktokLogo } from "./icons/PlatformLogos";

type CrossPlatform = "youtube" | "instagram" | "tiktok";
const CROSS_PLATFORMS: CrossPlatform[] = ["youtube", "instagram", "tiktok"];
const CROSS_CFG: Record<CrossPlatform, { label: string; Logo: (p: { className?: string }) => JSX.Element; light: string; text: string }> = {
  youtube:   { label: "YouTube",   Logo: YoutubeLogo,   light: "bg-red-500/10",    text: "text-red-500"    },
  instagram: { label: "Instagram", Logo: InstagramLogo, light: "bg-purple-500/10", text: "text-purple-500" },
  tiktok:    { label: "TikTok",    Logo: TiktokLogo,    light: "bg-pink-500/10",   text: "text-pink-500"   },
};

function formatDur(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));
}

// ── Emparejado entre plataformas ────────────────────────────────────────────────
// Arranca de lo que YA se sabe local (archivos con las 3 badges de plataforma
// marcadas) en vez de adivinar a ciegas comparando "últimos 20" de cada red —
// eso rompía porque cada plataforma publica a un ritmo distinto (ej. TikTok muy
// adelante de YouTube). Por cada archivo, muestra qué plataformas ya tienen el
// link resuelto y da una búsqueda puntual solo para las que faltan.

function SlotPicker({
  platform, fileId, fileName, onResolved, onCancel,
}: {
  platform: CrossPlatform;
  fileId: string;
  fileName: string;
  onResolved: (slot: PlatformRecentItem) => void;
  onCancel: () => void;
}) {
  const [items, setItems]   = useState<PlatformRecentItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  const loadPage = useCallback(async (after?: string) => {
    const page = await syncService.getPlatformRecent(platform, 10, after);
    setItems(prev => after ? [...prev, ...page.items] : page.items);
    setCursor(page.nextCursor);
  }, [platform]);

  useEffect(() => {
    setLoading(true);
    loadPage().finally(() => setLoading(false));
  }, [loadPage]);

  const handleUse = async (item: PlatformRecentItem) => {
    setResolving(item.platformId);
    try {
      await syncService.resolveCrossMatchSlot({
        fileId, platform, platformId: item.platformId, title: item.title,
        thumbnail: item.thumbnail, publishedAt: item.publishedAt, platformUrl: item.platformUrl,
        stats: item.stats,
      });
      onResolved(item);
    } finally {
      setResolving(null);
    }
  };

  const cfg = CROSS_CFG[platform];

  return (
    <div className="mt-2 p-2.5 rounded-lg border border-dashed border-border bg-secondary/30 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          Buscando en <span className={cfg.text}>{cfg.label}</span> el video que corresponde a "{fileName}"
        </p>
        <button onClick={onCancel} className="text-[11px] text-muted-foreground hover:text-foreground flex-shrink-0 ml-2">
          Cerrar
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">Sin videos encontrados en {cfg.label}.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto space-y-1">
          {items.map(item => (
            <div key={item.platformId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary/50 transition-colors">
              <div className="w-8 h-10 rounded bg-black overflow-hidden flex-shrink-0">
                {item.thumbnail && <img src={item.thumbnail} alt="" className="w-full h-full object-cover" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-foreground truncate">{item.title}</p>
                <p className="text-[10px] text-muted-foreground">{item.publishedAt ? formatDate(item.publishedAt) : "—"}</p>
              </div>
              <button
                onClick={() => handleUse(item)}
                disabled={resolving !== null}
                className="flex items-center gap-1 text-[11px] bg-primary/10 hover:bg-primary/20 text-primary px-2 py-1 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {resolving === item.platformId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                Usar este
              </button>
            </div>
          ))}
          {cursor && (
            <button
              onClick={() => { setLoadingMore(true); loadPage(cursor).finally(() => setLoadingMore(false)); }}
              disabled={loadingMore}
              className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-1.5 disabled:opacity-50"
            >
              {loadingMore ? "Cargando…" : "Cargar más"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PlatformSlotChip({
  platform, resolved, open, onToggle,
}: {
  platform: CrossPlatform;
  resolved: CrossMatchResolvedSlot | null;
  open: boolean;
  onToggle: () => void;
}) {
  const cfg  = CROSS_CFG[platform];
  const Logo = cfg.Logo;

  if (resolved) {
    return (
      <a
        href={resolved.platformUrl || undefined}
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg ${cfg.light} ${cfg.text}`}
        title={resolved.title}
      >
        <Logo className="w-3 h-3" />
        <Check className="w-3 h-3" />
      </a>
    );
  }

  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border border-dashed transition-colors ${
        open ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
      }`}
    >
      <Logo className="w-3 h-3" />
      Buscar
    </button>
  );
}

function CandidateCard({ candidate, localFileId, onSlotResolved, onOpenVideo }: {
  candidate: CrossMatchCandidate;
  localFileId: string | null;
  onSlotResolved: (fileId: string, platform: CrossPlatform, slot: PlatformRecentItem) => void;
  onOpenVideo?: (fileId: string, title: string) => void;
}) {
  const [openPlatform, setOpenPlatform] = useState<CrossPlatform | null>(null);
  const missing = CROSS_PLATFORMS.filter(p => !candidate.resolved[p]);
  const canPreview = !!localFileId;

  return (
    <div className="p-3 rounded-xl border border-border bg-card space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => canPreview && onOpenVideo?.(localFileId!, candidate.fileName)}
            disabled={!canPreview || !onOpenVideo}
            title={canPreview ? "Ver video para orientarse" : "No se encontró el archivo local"}
            className="w-9 h-12 rounded-md overflow-hidden bg-black flex-shrink-0 disabled:cursor-default"
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
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground truncate" title={candidate.fileName}>{candidate.fileName}</p>
            <p className="text-[10px] text-muted-foreground">{formatDate(candidate.fecha_creacion)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {CROSS_PLATFORMS.map(p => (
            <PlatformSlotChip
              key={p}
              platform={p}
              resolved={candidate.resolved[p]}
              open={openPlatform === p}
              onToggle={() => setOpenPlatform(prev => prev === p ? null : p)}
            />
          ))}
        </div>
      </div>

      {missing.length === 0 && (
        <p className="text-[11px] text-green-500 flex items-center gap-1"><Check className="w-3 h-3" /> Las 3 plataformas vinculadas</p>
      )}

      {openPlatform && (
        <SlotPicker
          platform={openPlatform}
          fileId={candidate.fileId}
          fileName={candidate.fileName}
          onCancel={() => setOpenPlatform(null)}
          onResolved={(slot) => { onSlotResolved(candidate.fileId, openPlatform, slot); setOpenPlatform(null); }}
        />
      )}
    </div>
  );
}

function CrossMatchPanel({ onOpenVideo }: { onOpenVideo?: (fileId: string, title: string) => void }) {
  const [candidates, setCandidates] = useState<CrossMatchCandidate[]>([]);
  // fileId de CrossMatchCandidate es el _id de Mongo (central) — el reproductor
  // y la miniatura viven en local-backend (SQLite), que usa OTRO id. Se resuelve
  // por file_name (único campo en común entre los dos catálogos) y se cachea acá.
  const [localIds, setLocalIds] = useState<Record<string, string | null>>({});
  const [page, setPage]             = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading]       = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const resolveLocalIds = async (items: CrossMatchCandidate[]) => {
    const names = items.map(c => c.fileName);
    try {
      const resolved = await videoService.resolveByNames(names);
      setLocalIds(prev => ({ ...prev, ...resolved }));
    } catch { /* sin id local → la miniatura/reproductor quedan deshabilitados para esos */ }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await syncService.getCrossMatchCandidates(1, 20);
      setCandidates(res.items);
      setPage(1);
      setTotalPages(res.totalPages);
      resolveLocalIds(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await syncService.getCrossMatchCandidates(page + 1, 20);
      setCandidates(prev => [...prev, ...res.items]);
      setPage(prev => prev + 1);
      setTotalPages(res.totalPages);
      resolveLocalIds(res.items);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleSlotResolved = (fileId: string, platform: CrossPlatform, slot: PlatformRecentItem) => {
    setCandidates(prev => prev.map(c => c.fileId !== fileId ? c : {
      ...c,
      resolved: {
        ...c.resolved,
        [platform]: { platformId: slot.platformId, platformUrl: slot.platformUrl ?? "", title: slot.title, thumbnail: slot.thumbnail },
      },
    }));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Emparejar entre plataformas</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Archivos ya publicados en las 3 redes (badges) — completá el link de las que falten. No toca linked_file_id de las que ya están.
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
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <p className="text-sm text-foreground font-medium">Sin candidatos todavía</p>
          <p className="text-xs text-muted-foreground">No hay archivos locales con las 3 badges de plataforma marcadas.</p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {candidates.map(c => (
              <CandidateCard
                key={c.fileId}
                candidate={c}
                localFileId={localIds[c.fileName] ?? null}
                onSlotResolved={handleSlotResolved}
                onOpenVideo={onOpenVideo}
              />
            ))}
          </div>
          {page < totalPages && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2 disabled:opacity-50"
            >
              {loadingMore ? "Cargando…" : "Cargar más candidatos"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Barra de estadísticas ──────────────────────────────────────────────────────

function StatsBar({ stats, onSync, syncing }: { stats: SyncStats; onSync: () => void; syncing: boolean }) {
  const pct = stats.youtube ? Math.round((stats.linked / stats.youtube) * 100) : 0;
  return (
    <div className="space-y-4 mb-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">YouTube</h3>
          <p className="text-xs text-muted-foreground">{stats.linked} de {stats.youtube} vinculados</p>
        </div>
        <button
          onClick={onSync}
          disabled={syncing}
          className="flex items-center gap-1.5 text-xs bg-secondary hover:bg-secondary/80 text-foreground px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Re-sincronizar
        </button>
      </div>

      {/* Barra de progreso */}
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="bg-green-500/10 rounded-lg p-3">
          <p className="text-lg font-bold text-green-400">{stats.linked}</p>
          <p className="text-xs text-muted-foreground">Vinculados</p>
        </div>
        <div className="bg-yellow-500/10 rounded-lg p-3">
          <p className="text-lg font-bold text-yellow-400">{stats.revisar}</p>
          <p className="text-xs text-muted-foreground">Revisar</p>
        </div>
        <div className="bg-muted/50 rounded-lg p-3">
          <p className="text-lg font-bold text-muted-foreground">{stats.sinMatch}</p>
          <p className="text-xs text-muted-foreground">Huérfanos</p>
        </div>
      </div>
    </div>
  );
}

// ── Tarjeta de un video YT con sus candidatos ──────────────────────────────────

function ReviewCard({
  item,
  onLink,
  onOrphan,
}: {
  item: SyncReviewItem;
  onLink: (pvId: string, fileId: string) => void;
  onOrphan: (pvId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null); // fileId o "orphan"

  const handleLink = async (fileId: string) => {
    setBusy(fileId);
    await onLink(item._id, fileId);
    setBusy(null);
  };

  const handleOrphan = async () => {
    setBusy("orphan");
    await onOrphan(item._id);
    setBusy(null);
  };

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card">
      {/* Cabecera YouTube */}
      <div className="flex gap-3 p-3 bg-red-500/5 border-b border-border">
        <img
          src={item.thumbnail}
          alt={item.title}
          className="w-20 h-12 rounded-lg object-cover flex-shrink-0 bg-secondary"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Tv2 className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
            <span className="text-xs text-red-400 font-medium">YouTube</span>
            <span className="text-xs text-muted-foreground ml-auto">{formatDur(item.durationSeconds)}</span>
          </div>
          <p className="text-sm font-medium text-foreground leading-tight line-clamp-2">{item.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{formatDate(item.publishedAt)}</p>
        </div>
      </div>

      {/* Candidatos locales */}
      <div className="p-2 space-y-1">
        {item.candidates.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">Sin candidatos por duración</p>
        ) : (
          item.candidates.map((c) => (
            <div key={c._id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary/50 transition-colors">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground truncate">{c.file_name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDur(c.duracion_segundos)} · {c.fecha_creacion ? formatDate(c.fecha_creacion) : "—"}
                </p>
              </div>
              <button
                onClick={() => handleLink(c._id)}
                disabled={busy !== null}
                className="flex items-center gap-1 text-xs bg-primary/10 hover:bg-primary/20 text-primary px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {busy === c._id
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Link2 className="w-3 h-3" />
                }
                Vincular
              </button>
            </div>
          ))
        )}

        {/* Marcar huérfano */}
        <button
          onClick={handleOrphan}
          disabled={busy !== null}
          className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary py-1.5 rounded-lg transition-colors disabled:opacity-50 mt-1"
        >
          {busy === "orphan" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unlink className="w-3 h-3" />}
          Marcar como huérfano
        </button>
      </div>
    </div>
  );
}

// ── Panel principal ────────────────────────────────────────────────────────────

export function SyncPanel({ onOpenVideo }: { onOpenVideo?: (fileId: string, title: string) => void } = {}) {
  const [stats, setStats]       = useState<SyncStats | null>(null);
  const [items, setItems]       = useState<SyncReviewItem[]>([]);
  const [page, setPage]         = useState(1);
  const [totalPages, setTotal]  = useState(1);
  const [loading, setLoading]   = useState(true);
  const [syncing, setSyncing]   = useState(false);

  const loadStats = useCallback(async () => {
    const s = await syncService.getStats();
    setStats(s);
  }, []);

  const loadReview = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const data = await syncService.getReview(p);
      setItems(data.items);
      setTotal(data.totalPages);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadReview(1);
  }, [loadStats, loadReview]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncService.triggerSync();
      await loadStats();
    } finally {
      setSyncing(false);
    }
  };

  const handleLink = async (pvId: string, fileId: string) => {
    await syncService.confirmLink(pvId, fileId);
    setItems((prev) => prev.filter((i) => i._id !== pvId));
    setStats((s) => s ? { ...s, linked: s.linked + 1, revisar: s.revisar - 1 } : s);
  };

  const handleOrphan = async (pvId: string) => {
    await syncService.markOrphan(pvId);
    setItems((prev) => prev.filter((i) => i._id !== pvId));
    setStats((s) => s ? { ...s, sinMatch: s.sinMatch + 1, revisar: s.revisar - 1 } : s);
  };

  const changePage = (p: number) => {
    setPage(p);
    loadReview(p);
  };

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Emparejado entre plataformas — independiente del match con archivo local */}
      <CrossMatchPanel onOpenVideo={onOpenVideo} />

      <div className="border-t border-border pt-6 space-y-6 max-w-2xl">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Vincular con archivo local</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Match automático de YouTube contra tu biblioteca local (por duración/fecha).
        </p>
      </div>
      {/* Stats */}
      {stats && <StatsBar stats={stats} onSync={handleSync} syncing={syncing} />}

      {/* Lista de revisión */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Revisión manual</h3>
          {stats && (
            <span className="text-xs text-muted-foreground">{stats.revisar} pendientes</span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 space-y-2">
            <Check className="w-8 h-8 text-green-400 mx-auto" />
            <p className="text-sm text-foreground font-medium">Todo revisado</p>
            <p className="text-xs text-muted-foreground">No hay videos pendientes de revisión</p>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <ReviewCard
                key={item._id}
                item={item}
                onLink={handleLink}
                onOrphan={handleOrphan}
              />
            ))}
          </div>
        )}

        {/* Paginación */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-4">
            <button
              onClick={() => changePage(page - 1)}
              disabled={page === 1}
              className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs text-muted-foreground">{page} / {totalPages}</span>
            <button
              onClick={() => changePage(page + 1)}
              disabled={page === totalPages}
              className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
