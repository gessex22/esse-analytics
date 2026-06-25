import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Search, RefreshCw, Crown, User, AlertCircle, UserX, ChevronDown, ExternalLink } from "lucide-react";
import { API_BASE } from "../config";

// ── Iconos de plataforma (SVG inline para no depender de paquetes externos) ───

function YouTubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  );
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>
    </svg>
  );
}

function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34l.04-8.37a8.26 8.26 0 0 0 4.83 1.55V5.04a4.85 4.85 0 0 1-1.1-.35z"/>
    </svg>
  );
}

const PLATFORM_META: Record<string, {
  label: string;
  color: string;
  bg: string;
  Icon: React.FC<{ className?: string }>;
  accountKey: keyof AppUser;
  urlKey?: keyof AppUser;
}> = {
  youtube:   { label: "YouTube",   color: "text-red-400",  bg: "bg-red-500/10",   Icon: YouTubeIcon,   accountKey: "youtubeChannel",   urlKey: "youtubeChannelUrl" },
  instagram: { label: "Instagram", color: "text-pink-400", bg: "bg-pink-500/10",  Icon: InstagramIcon, accountKey: "instagramAccount" },
  tiktok:    { label: "TikTok",    color: "text-sky-400",  bg: "bg-sky-500/10",   Icon: TikTokIcon,    accountKey: "tiktokAccount" },
};

function PlatformBadges({ user }: { user: AppUser }) {
  const platforms = user.linkedPlatforms ?? [];
  if (platforms.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {platforms.map(p => {
        const meta = PLATFORM_META[p];
        if (!meta) return null;
        const { Icon, label, color, bg, accountKey, urlKey } = meta;
        const account = user[accountKey] as string | undefined;
        const url     = urlKey ? (user[urlKey] as string | undefined) : undefined;

        return (
          <span
            key={p}
            className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${bg} ${color}`}
          >
            <Icon className="w-3 h-3 flex-shrink-0" />
            {account ? account : label}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
              >
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
          </span>
        );
      })}
    </div>
  );
}

interface AppUser {
  id: string;
  username: string;
  role: string;
  tier: "free" | "premium";
  status: "active" | "deleted";
  email?: string;
  linkedPlatforms?: string[];
  youtubeChannel?: string;
  youtubeChannelUrl?: string;
  instagramAccount?: string;
  tiktokAccount?: string;
  firstLinkedAt?: string;
  createdAt?: string;
  deletedAt?: string;
}

function getAuthHeader() {
  const token = localStorage.getItem("esse_auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function Toggle({ on, onChange, loading }: { on: boolean; onChange: () => void; loading?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={loading}
      aria-checked={on}
      role="switch"
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors duration-200 focus:outline-none ${
        loading
          ? "opacity-50 cursor-wait border-border bg-secondary"
          : on
          ? "bg-amber-500 border-amber-500 cursor-pointer"
          : "bg-secondary border-border cursor-pointer"
      }`}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 500, damping: 35 }}
        className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm ${on ? "ml-[22px]" : "ml-1"}`}
      />
    </button>
  );
}

type StatusFilter = "active" | "deleted";

export function UsersPanel() {
  const [users, setUsers]           = useState<AppUser[]>([]);
  const [total, setTotal]           = useState(0);
  const [query, setQuery]           = useState("");
  const [statusFilter, setStatus]   = useState<StatusFilter>("active");
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(false);
  const [toggling, setToggling]     = useState<string | null>(null);
  const [deactivating, setDeact]    = useState<string | null>(null);
  const [confirmId, setConfirmId]   = useState<string | null>(null);
  const debounceRef                 = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (q: string, status: StatusFilter) => {
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams({ status, limit: "5" });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`${API_BASE}/api/auth/users?${params}`, {
        headers: getAuthHeader() as HeadersInit,
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setUsers(data.users ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Carga inicial
  useEffect(() => { load(query, statusFilter); }, []);

  // Búsqueda con debounce
  const handleSearch = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(val, statusFilter), 350);
  };

  const handleStatusFilter = (s: StatusFilter) => {
    setStatus(s);
    load(query, s);
  };

  const toggleTier = async (user: AppUser) => {
    const newTier = user.tier === "premium" ? "free" : "premium";
    setToggling(user.id);
    try {
      await fetch(`${API_BASE}/api/auth/users/${user.id}/tier`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeader() } as HeadersInit,
        body: JSON.stringify({ tier: newTier }),
      });
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, tier: newTier } : u));
    } catch {/* best effort */}
    setToggling(null);
  };

  const deactivate = async (userId: string) => {
    setDeact(userId);
    setConfirmId(null);
    try {
      await fetch(`${API_BASE}/api/auth/users/${userId}/deactivate`, {
        method: "PATCH",
        headers: getAuthHeader() as HeadersInit,
      });
      await load(query, statusFilter);
    } catch {/* best effort */}
    setDeact(null);
  };

  const showingDeleted = statusFilter === "deleted";

  return (
    <div className="space-y-5 max-w-3xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Usuarios</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {total} {showingDeleted ? "dados de baja" : "activos"}
            {query ? ` · búsqueda: "${query}"` : " · últimos 5"}
          </p>
        </div>
        <button
          onClick={() => load(query, statusFilter)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refrescar
        </button>
      </div>

      {/* Búsqueda + filtro */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Buscar por usuario o email..."
            value={query}
            onChange={e => handleSearch(e.target.value)}
            className="w-full pl-9 pr-8 py-2.5 text-sm rounded-lg border border-border bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50 transition-colors"
          />
          <AnimatePresence>
            {query && (
              <motion.button
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => handleSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
              >✕</motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Filtro de baja */}
        <div className="relative">
          <select
            value={statusFilter}
            onChange={e => handleStatusFilter(e.target.value as StatusFilter)}
            className="appearance-none pl-3 pr-8 py-2.5 text-sm rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer transition-colors"
          >
            <option value="active">Activos</option>
            <option value="deleted">Dados de baja</option>
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        </div>
      </div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 text-sm text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            No se pudieron cargar los usuarios.
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lista */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-secondary/50 animate-pulse" style={{ opacity: 1 - i * 0.15 }} />
          ))}
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-14 text-muted-foreground text-sm">
          {query ? `Sin resultados para "${query}"` : showingDeleted ? "No hay usuarios dados de baja." : "No hay usuarios registrados."}
        </div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {users.map(user => (
              <motion.div
                key={user.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -8 }}
                className="flex items-center gap-3 px-4 py-3.5 rounded-xl border border-border bg-card"
              >
                {/* Avatar */}
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold flex-shrink-0 ${
                  user.tier === "premium" ? "bg-amber-500/15 text-amber-400" : "bg-primary/10 text-primary"
                }`}>
                  {user.username[0].toUpperCase()}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-foreground truncate">{user.username}</span>
                    {user.tier === "premium" && <Crown className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground capitalize flex items-center gap-1">
                      <User className="w-3 h-3" />{user.role}
                    </span>
                    {user.deletedAt && (
                      <span className="text-xs text-muted-foreground/60">
                        baja {new Date(user.deletedAt).toLocaleDateString("es")}
                      </span>
                    )}
                  </div>
                  <PlatformBadges user={user} />
                </div>

                {/* Tier badge */}
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium hidden sm:inline-block flex-shrink-0 ${
                  user.tier === "premium" ? "bg-amber-500/15 text-amber-400" : "bg-secondary text-muted-foreground"
                }`}>
                  {user.tier}
                </span>

                {/* Toggle premium */}
                {!showingDeleted && (
                  <Toggle
                    on={user.tier === "premium"}
                    onChange={() => toggleTier(user)}
                    loading={toggling === user.id}
                  />
                )}

                {/* Dar de baja */}
                {!showingDeleted && (
                  confirmId === user.id ? (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => deactivate(user.id)}
                        disabled={deactivating === user.id}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                      >
                        {deactivating === user.id ? "..." : "Confirmar"}
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className="text-xs px-2 py-1.5 rounded-lg hover:bg-secondary text-muted-foreground transition-colors"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmId(user.id)}
                      title="Dar de baja"
                      className="flex-shrink-0 p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                    >
                      <UserX className="w-4 h-4" />
                    </button>
                  )
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {users.length > 0 && (
        <p className="text-xs text-muted-foreground text-center pb-2">
          Mostrando {users.length} de {total}
          {total > 5 && !query && (
            <span className="text-muted-foreground/60"> · busca para ver más</span>
          )}
        </p>
      )}
    </div>
  );
}
