import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Download, RefreshCw, AlertCircle, Copy, Check, Lock, Wifi, Globe } from "lucide-react";
import { API_BASE } from "../config";
import type { UserTier } from "../hooks/useAuth";

// ── Tipos ─────────────────────────────────────────────────────────────────────

type GemColor  = "blue" | "purple" | "amber" | "teal" | "coral" | "pink" | "green";
type GemStatus = "not_installed" | "installed" | "running";
type GemType   = "builtin" | "plugin";

interface GemDef {
  id:          string;
  name:        string;
  tagline:     string;
  description: string;
  color:       GemColor;
  version:     string;
  type:        GemType;
  tier:        UserTier;        // tier mínimo requerido
  soon?:       boolean;
}

// ── Definición de gemas ───────────────────────────────────────────────────────

const GEMS: GemDef[] = [
  {
    id:          "esse_local_access",
    name:        "Acceso Local",
    tagline:     "App en tu red local",
    description: "Accede a EsseAnalytics desde cualquier dispositivo conectado a tu misma red WiFi. Sin configuración extra.",
    color:       "green",
    version:     "builtin",
    type:        "builtin",
    tier:        "free",
  },
  {
    id:          "esse_transcrip",
    name:        "esse-Transcrip",
    tagline:     "Transcripción con IA",
    description: "Transcribe tus videos automáticamente usando Whisper. Detecta tu GPU y elige el modelo óptimo: CPU, NVIDIA o Apple Silicon.",
    color:       "blue",
    version:     "1.0.0",
    type:        "plugin",
    tier:        "free",
  },
  {
    id:          "esse_remote_access",
    name:        "Acceso Remoto",
    tagline:     "App desde cualquier lugar",
    description: "Accede a tu app desde fuera de tu red, desde el móvil o cualquier dispositivo, de forma segura con túnel encriptado.",
    color:       "purple",
    version:     "1.0.0",
    type:        "plugin",
    tier:        "premium",
  },
  {
    id:          "esse_thumb",
    name:        "esse-Thumb",
    tagline:     "Miniaturas con IA",
    description: "Genera miniaturas llamativas para YouTube e Instagram usando modelos de imagen generativa.",
    color:       "coral",
    version:     "1.0.0",
    type:        "plugin",
    tier:        "premium",
    soon:        true,
  },
];

// ── Paleta ────────────────────────────────────────────────────────────────────

const COLOR: Record<GemColor, { bg: string; border: string; text: string; badge: string; pill: string }> = {
  blue:   { bg: "bg-blue-500/10",   border: "border-blue-500/25",   text: "text-blue-400",   badge: "bg-blue-500/15 text-blue-400",   pill: "bg-blue-500/15 text-blue-400"   },
  purple: { bg: "bg-purple-500/10", border: "border-purple-500/25", text: "text-purple-400", badge: "bg-purple-500/15 text-purple-400", pill: "bg-purple-500/15 text-purple-400" },
  amber:  { bg: "bg-amber-500/10",  border: "border-amber-500/25",  text: "text-amber-400",  badge: "bg-amber-500/15 text-amber-400",  pill: "bg-amber-500/15 text-amber-400"  },
  teal:   { bg: "bg-teal-500/10",   border: "border-teal-500/25",   text: "text-teal-400",   badge: "bg-teal-500/15 text-teal-400",   pill: "bg-teal-500/15 text-teal-400"   },
  coral:  { bg: "bg-orange-500/10", border: "border-orange-500/25", text: "text-orange-400", badge: "bg-orange-500/15 text-orange-400", pill: "bg-orange-500/15 text-orange-400" },
  pink:   { bg: "bg-pink-500/10",   border: "border-pink-500/25",   text: "text-pink-400",   badge: "bg-pink-500/15 text-pink-400",   pill: "bg-pink-500/15 text-pink-400"   },
  green:  { bg: "bg-green-500/10",  border: "border-green-500/25",  text: "text-green-400",  badge: "bg-green-500/15 text-green-400",  pill: "bg-green-500/15 text-green-400"  },
};

// ── Ícono de gema ─────────────────────────────────────────────────────────────

const GEM_COLORS: Record<GemColor, { fill: string; stroke: string }> = {
  blue:   { fill: "#3b82f6", stroke: "#60a5fa" },
  purple: { fill: "#a855f7", stroke: "#c084fc" },
  amber:  { fill: "#f59e0b", stroke: "#fcd34d" },
  teal:   { fill: "#14b8a6", stroke: "#5eead4" },
  coral:  { fill: "#f97316", stroke: "#fdba74" },
  pink:   { fill: "#ec4899", stroke: "#f9a8d4" },
  green:  { fill: "#22c55e", stroke: "#86efac" },
};

function GemIcon({ color, size = 36 }: { color: GemColor; size?: number }) {
  const { fill, stroke } = GEM_COLORS[color];
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points="20,4 32,14 20,14 8,14"  fill={stroke} opacity="0.9" />
      <polygon points="8,14 20,14 14,34"        fill={fill}   opacity="0.85" />
      <polygon points="32,14 20,14 26,34"       fill={fill}   opacity="0.7" />
      <polygon points="20,14 14,34 26,34"       fill={fill}   opacity="0.95" />
      <polygon points="20,4 26,11 20,11"        fill="white"  opacity="0.25" />
    </svg>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      aria-checked={on}
      role="switch"
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors duration-200 focus:outline-none ${
        disabled
          ? "opacity-30 cursor-not-allowed border-border bg-secondary"
          : on
          ? "bg-primary border-primary cursor-pointer"
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

// ── Badge de estado ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: GemStatus | "loading" }) {
  if (status === "loading") return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <RefreshCw className="w-3 h-3 animate-spin" />
    </span>
  );
  if (status === "not_installed") return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
      No instalada
    </span>
  );
  if (status === "installed") return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      Instalada
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
      <motion.span
        className="w-1.5 h-1.5 rounded-full bg-primary"
        animate={{ opacity: [1, 0.3, 1] }}
        transition={{ repeat: Infinity, duration: 1.4 }}
      />
      Activa
    </span>
  );
}

// ── Panel de IPs para Acceso Local ────────────────────────────────────────────

function LocalNetworkInfo() {
  const [data, setData]     = useState<{ urls: string[] } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/gems/local-network`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  const copy = (url: string) => {
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(url);
    setTimeout(() => setCopied(null), 2000);
  };

  if (!data) return null;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="space-y-1.5 overflow-hidden"
    >
      <p className="text-xs text-muted-foreground">Accede desde otros dispositivos en tu red:</p>
      {data.urls.map(url => (
        <div key={url} className="flex items-center justify-between bg-secondary rounded-lg px-3 py-2">
          <span className="text-xs font-mono text-foreground">{url}</span>
          <button
            onClick={() => copy(url)}
            className="text-muted-foreground hover:text-foreground transition-colors ml-2 flex-shrink-0"
          >
            {copied === url ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      ))}
    </motion.div>
  );
}

// ── Badge de estado extendido ─────────────────────────────────────────────────

function LockedBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
      <Lock className="w-3 h-3" />
      Solo Premium
    </span>
  );
}

// ── Tarjeta de gema ───────────────────────────────────────────────────────────

function GemCard({
  gem,
  status,
  userTier,
  isLocal,
  onToggle,
  onRefresh,
}: {
  gem:       GemDef;
  status:    GemStatus | "loading";
  userTier:  UserTier;
  isLocal:   boolean;
  onToggle:  () => void;
  onRefresh: () => void;
}) {
  const c         = COLOR[gem.color];
  const locked    = gem.tier === "premium" && userTier === "free";
  const on        = status === "running";
  // Toggle activo solo si: es local, no es premium-locked, no está "pronto", y está instalada/activa
  const canToggle = isLocal && !locked && !gem.soon && (status === "installed" || status === "running");
  const isBuiltin = gem.type === "builtin";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-xl border p-5 flex flex-col gap-4 transition-colors ${
        gem.soon
          ? "border-border/40 bg-card/50 opacity-60"
          : `${c.border} bg-card`
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-xl ${c.bg}`}>
            {gem.id === "esse_local_access"  ? <Wifi  className={`w-6 h-6 ${c.text}`} /> :
             gem.id === "esse_remote_access" ? <Globe className={`w-6 h-6 ${c.text}`} /> :
             <GemIcon color={gem.color} size={32} />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-semibold text-foreground leading-tight">{gem.name}</p>
              {gem.tier === "premium" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium leading-none">
                  PREMIUM
                </span>
              )}
            </div>
            <p className={`text-xs font-medium ${c.text}`}>{gem.tagline}</p>
          </div>
        </div>

        {/* Toggle + lock icon */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {locked && <Lock className="w-3.5 h-3.5 text-amber-400/70" />}
          <Toggle on={on} onChange={onToggle} disabled={!canToggle} />
        </div>
      </div>

      {/* Descripción */}
      <p className="text-sm text-muted-foreground leading-relaxed">{gem.description}</p>

      {/* Info de red local cuando está activa */}
      <AnimatePresence>
        {gem.id === "esse_local_access" && on && <LocalNetworkInfo />}
      </AnimatePresence>

      {/* Footer */}
      <div className="flex items-center justify-between mt-auto pt-1">

        {/* Badge de estado */}
        {locked
          ? <LockedBadge />
          : !isLocal
          ? <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
              Solo app de escritorio
            </span>
          : <StatusBadge status={status} />
        }

        <div className="flex items-center gap-2">
          {isLocal && !gem.soon && !isBuiltin && (
            <button
              onClick={onRefresh}
              className="text-muted-foreground hover:text-foreground p-1 transition-colors"
              title="Refrescar estado"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}

          {isLocal && status === "not_installed" && !gem.soon && !locked && (
            <button
              onClick={() => alert(
                `Coloca el ejecutable en:\n~/.esse-analytics/gems/\n\nNombre del archivo:\n${
                  navigator.platform.startsWith("Win") ? `${gem.id}.exe` : gem.id
                }`
              )}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Instalar
            </button>
          )}

          {gem.soon && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
              Próximamente
            </span>
          )}

          {!gem.soon && (
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-mono ${c.pill}`}>
              {isBuiltin ? "nativo" : `v${gem.version}`}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ── Panel principal ───────────────────────────────────────────────────────────

type StatusMap = Record<string, GemStatus | "loading">;

export function GemsPanel({ isLocal, userTier }: { isLocal: boolean; userTier: UserTier }) {
  const [statuses, setStatuses] = useState<StatusMap>(() =>
    Object.fromEntries(GEMS.map(g => [g.id, g.soon ? "not_installed" : "loading"]))
  );
  const [error, setError] = useState(false);

  const loadStatuses = useCallback(async () => {
    if (!isLocal) return;
    setError(false);
    try {
      const res  = await fetch(`${API_BASE}/api/gems`);
      if (!res.ok) throw new Error();
      const data: { id: string; status: GemStatus }[] = await res.json();
      setStatuses(prev => {
        const next = { ...prev };
        data.forEach(({ id, status }) => { next[id] = status; });
        return next;
      });
    } catch {
      setError(true);
      setStatuses(prev => {
        const next = { ...prev };
        GEMS.forEach(g => { if (next[g.id] === "loading") next[g.id] = "not_installed"; });
        return next;
      });
    }
  }, [isLocal]);

  useEffect(() => { loadStatuses(); }, [loadStatuses]);

  const toggle = async (gem: GemDef) => {
    const current = statuses[gem.id];
    if (current === "not_installed" || current === "loading") return;

    const action = current === "running" ? "stop" : "start";
    setStatuses(prev => ({ ...prev, [gem.id]: "loading" }));

    try {
      await fetch(`${API_BASE}/api/gems/${gem.id}/${action}`, { method: "POST" });
    } catch {/* best effort */}

    await loadStatuses();
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Encabezado */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Gemas</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Plugins que potencian tu flujo. Actívalos desde la app de escritorio.
          </p>
        </div>
        {isLocal && (
          <button
            onClick={loadStatuses}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refrescar
          </button>
        )}
      </div>

      {/* Banner: acceso web (no local) */}
      {!isLocal && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground bg-secondary/60 border border-border rounded-lg px-4 py-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0 text-primary/60" />
          Para activar las gemas necesitas la{" "}
          <a
            href="https://github.com/gessex22/esse-analytics/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-primary hover:text-primary/80 transition-colors"
          >
            app de escritorio
          </a>
        </div>
      )}

      {/* Error de conexión (solo en local) */}
      <AnimatePresence>
        {isLocal && error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 text-sm text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            No se pudo consultar el estado de las gemas. ¿Está corriendo el backend local?
          </motion.div>
        )}
      </AnimatePresence>

      {/* Grid de tarjetas — siempre visible */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {GEMS.map(gem => (
          <GemCard
            key={gem.id}
            gem={gem}
            status={isLocal ? (statuses[gem.id] ?? "loading") : "not_installed"}
            userTier={userTier}
            isLocal={isLocal}
            onToggle={() => toggle(gem)}
            onRefresh={loadStatuses}
          />
        ))}
      </div>

      {isLocal && (
        <p className="text-xs text-muted-foreground text-center pb-2">
          Ejecutables en{" "}
          <code className="font-mono bg-secondary px-1 py-0.5 rounded">~/.esse-analytics/gems/</code>
        </p>
      )}
    </div>
  );
}
