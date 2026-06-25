import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Monitor, Smartphone, Tablet, CheckCircle2, XCircle, Clock, Star, User, Loader2, Trash2, ExternalLink } from "lucide-react";

function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  );
}
import { API_BASE } from "../config";

interface LoginLog {
  _id: string;
  username: string;
  success: boolean;
  failReason?: "user_not_found" | "wrong_password" | "server_error";
  ip: string;
  browser: string;
  os: string;
  device: string;
  at: string;
}

interface AppUser {
  id: string;
  username: string;
  role: string;
  tier: "free" | "premium";
  status?: "active" | "deleted";
  email?: string;
  youtubeChannel?: string;
  youtubeChannelUrl?: string;
  instagramAccount?: string;
  tiktokAccount?: string;
  linkedPlatforms?: string[];
  verified?: boolean;
  firstLinkedAt?: string;
  deletedAt?: string;
  createdAt?: string;
}

function getAuthHeader() {
  const token = localStorage.getItem("esse_auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function DeviceIcon({ device }: { device: string }) {
  const d = device.toLowerCase();
  if (d === "mobile") return <Smartphone className="w-4 h-4" />;
  if (d === "tablet") return <Tablet className="w-4 h-4" />;
  return <Monitor className="w-4 h-4" />;
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("es", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

const FAIL_LABEL: Record<string, string> = {
  user_not_found: "Usuario no existe",
  wrong_password: "Contraseña incorrecta",
  server_error:   "Error del servidor",
};

const ROLE_LABEL: Record<string, string> = {
  todopoderoso: "Admin",
  editor:       "Editor",
  visitante:    "Visitante",
};

// ── Gestión de usuarios ───────────────────────────────────────────────────────
type UserFilter = "all" | "verified" | "unlinked" | "deleted";

function UsersPanel() {
  const [users,   setUsers]   = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState<string | null>(null);
  const [filter,  setFilter]  = useState<UserFilter>("all");

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/users`, { headers: getAuthHeader() })
      .then(r => r.json())
      .then(data => setUsers(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleTier = async (user: AppUser) => {
    const newTier = user.tier === "premium" ? "free" : "premium";
    setSaving(user.id);
    try {
      const res = await fetch(`${API_BASE}/api/auth/users/${user.id}/tier`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeader() },
        body: JSON.stringify({ tier: newTier }),
      });
      if (res.ok) {
        setUsers(prev => prev.map(u => u.id === user.id ? { ...u, tier: newTier } : u));
      }
    } finally {
      setSaving(null);
    }
  };

  if (loading) return (
    <div className="flex justify-center py-6">
      <motion.span className="w-6 h-6 rounded-full border-2 border-primary/30 block"
        style={{ borderTopColor: "var(--primary)" }}
        animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }} />
    </div>
  );

  const counts = {
    all: users.length,
    verified: users.filter(u => u.verified && u.status !== "deleted").length,
    unlinked: users.filter(u => !u.verified && u.status !== "deleted").length,
    deleted: users.filter(u => u.status === "deleted").length,
  };

  const visible = users.filter(u => {
    if (filter === "verified") return u.verified && u.status !== "deleted";
    if (filter === "unlinked") return !u.verified && u.status !== "deleted";
    if (filter === "deleted")  return u.status === "deleted";
    return true;
  });

  const FILTERS: { key: UserFilter; label: string }[] = [
    { key: "all",      label: "Todos" },
    { key: "verified", label: "Verificados" },
    { key: "unlinked", label: "Sin vincular" },
    { key: "deleted",  label: "Bajas" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 flex-wrap mb-1">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-2.5 py-1 rounded-full text-[11px] border transition-colors ${
              filter === f.key
                ? "bg-primary/20 text-primary border-primary/50 font-semibold"
                : "bg-secondary/40 text-muted-foreground border-border hover:text-foreground"
            }`}
          >
            {f.label} <span className="opacity-60">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      {visible.map((u, i) => (
        <motion.div key={u.id}
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          className="flex items-center gap-3 bg-card border border-border rounded-xl px-4 py-3"
        >
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <User className="w-4 h-4 text-primary/60" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className={`text-sm font-medium truncate ${u.status === "deleted" ? "text-muted-foreground line-through" : "text-foreground"}`}>{u.username}</p>
              {u.status === "deleted"
                ? <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-border bg-secondary text-muted-foreground flex-shrink-0">Baja</span>
                : u.verified
                  ? <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 flex-shrink-0">Verificado</span>
                  : <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400 flex-shrink-0">Sin vincular</span>}
            </div>
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              <span className="text-xs text-muted-foreground">{ROLE_LABEL[u.role] ?? u.role}</span>
              {u.youtubeChannel && (
                <span className="flex items-center gap-1 text-[11px] text-red-400/80">
                  <YoutubeIcon className="w-3 h-3" />
                  {u.youtubeChannelUrl
                    ? <a href={u.youtubeChannelUrl} target="_blank" rel="noopener noreferrer" className="hover:text-red-400 flex items-center gap-0.5">
                        {u.youtubeChannel} <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    : u.youtubeChannel}
                </span>
              )}
              {u.instagramAccount && <span className="text-[11px] text-pink-400/80">IG: {u.instagramAccount}</span>}
              {u.tiktokAccount && <span className="text-[11px] text-foreground/70">TikTok: {u.tiktokAccount}</span>}
            </div>
          </div>

          {/* Badge tier actual */}
          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold flex-shrink-0 ${
            u.tier === "premium"
              ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
              : "text-muted-foreground bg-secondary border-border"
          }`}>
            {u.tier === "premium" ? "Premium" : "Free"}
          </span>

          {/* Toggle */}
          <button
            onClick={() => toggleTier(u)}
            disabled={saving === u.id}
            title={u.tier === "premium" ? "Quitar premium" : "Activar premium"}
            className={`relative w-10 h-5.5 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
              u.tier === "premium" ? "bg-amber-500" : "bg-border"
            }`}
            style={{ height: "1.375rem" }}
          >
            {saving === u.id
              ? <Loader2 className="w-3 h-3 animate-spin absolute inset-0 m-auto text-white" />
              : <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  u.tier === "premium" ? "translate-x-[1.125rem]" : "translate-x-0"
                }`} />
            }
          </button>
        </motion.div>
      ))}
    </div>
  );
}

// ── Panel principal ───────────────────────────────────────────────────────────
export function SecurityPanel() {
  const [logs,    setLogs]    = useState<LoginLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/logs`, { headers: getAuthHeader() })
      .then(r => r.json())
      .then(data => { setLogs(data); setLoading(false); })
      .catch(() => { setError("No se pudieron cargar los registros."); setLoading(false); });
  }, []);

  return (
    <div className="space-y-8 max-w-lg">

      {/* ── Usuarios y tiers ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" /> Usuarios
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Activá el acceso remoto Premium por usuario
          </p>
        </div>
        <UsersPanel />
      </section>

      {/* ── Últimas conexiones ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Últimas conexiones</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Registro de los 5 accesos más recientes
            </p>
          </div>
          {logs.length > 0 && (
            <button
              onClick={async () => {
                const token = localStorage.getItem("esse_auth_token");
                const ok = window.confirm("¿Limpiar todos los registros de acceso?");
                if (!ok) return;
                await fetch(`${API_BASE}/api/auth/logs`, {
                  method: "DELETE",
                  headers: getAuthHeader(),
                });
                setLogs([]);
              }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-red-400 transition-colors flex-shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" /> Limpiar
            </button>
          )}
        </div>

        {loading && (
          <div className="flex justify-center py-8">
            <motion.span className="w-7 h-7 rounded-full border-2 border-primary/30 block"
              style={{ borderTopColor: "var(--primary)" }}
              animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }} />
          </div>
        )}

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
        )}

        {!loading && !error && logs.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">Sin registros aún.</p>
        )}

        <div className="space-y-2.5">
          {logs.map((log, i) => (
            <motion.div key={log._id}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.2 }}
              className={`rounded-xl border p-4 flex items-start gap-3 ${
                log.success ? "bg-card/40 border-border" : "bg-red-500/5 border-red-500/20"
              }`}
            >
              <div className={`mt-0.5 flex-shrink-0 ${log.success ? "text-emerald-400" : "text-red-400"}`}>
                {log.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground truncate">{log.username}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium flex-shrink-0 ${
                    log.success
                      ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                      : "text-red-400 bg-red-500/10 border-red-500/30"
                  }`}>
                    {log.success ? "Exitoso" : (FAIL_LABEL[log.failReason ?? ""] ?? "Fallido")}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <DeviceIcon device={log.device} />
                    {log.browser} · {log.os}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-[11px] text-muted-foreground font-mono bg-secondary/40 px-1.5 py-0.5 rounded break-all">
                    {log.ip}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                    <Clock className="w-3 h-3" />
                    {formatDate(log.at)}
                  </span>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </section>
    </div>
  );
}
