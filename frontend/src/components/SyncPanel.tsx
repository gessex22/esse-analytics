import { useState, useEffect, useCallback } from "react";
import { Tv2, Link2, Unlink, ChevronLeft, ChevronRight, RefreshCw, Check, Loader2 } from "lucide-react";
import { syncService, SyncReviewItem, SyncStats } from "../services/api";

function formatDur(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));
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

export function SyncPanel() {
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
    <div className="space-y-6 max-w-2xl">
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
  );
}
