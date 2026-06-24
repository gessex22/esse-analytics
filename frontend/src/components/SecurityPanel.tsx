import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Monitor, Smartphone, Tablet, CheckCircle2, XCircle, Clock } from "lucide-react";

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

import { API_BASE } from "../config";

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
  server_error: "Error del servidor",
};

export function SecurityPanel() {
  const [logs, setLogs] = useState<LoginLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/logs`, { headers: getAuthHeader() })
      .then((r) => r.json())
      .then((data) => { setLogs(data); setLoading(false); })
      .catch(() => { setError("No se pudieron cargar los registros."); setLoading(false); });
  }, []);

  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Últimas conexiones</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Registro de los 5 accesos más recientes a la plataforma
        </p>
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <motion.span
            className="w-7 h-7 rounded-full border-2 border-primary/30 block"
            style={{ borderTopColor: "var(--primary)" }}
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
          />
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {!loading && !error && logs.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-8">Sin registros aún.</p>
      )}

      <div className="space-y-2.5">
        {logs.map((log, i) => (
          <motion.div
            key={log._id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.2 }}
            className={`rounded-xl border p-4 flex items-start gap-3 ${
              log.success
                ? "bg-card/40 border-border"
                : "bg-red-500/5 border-red-500/20"
            }`}
          >
            {/* Ícono estado */}
            <div className={`mt-0.5 flex-shrink-0 ${log.success ? "text-emerald-400" : "text-red-400"}`}>
              {log.success
                ? <CheckCircle2 className="w-4 h-4" />
                : <XCircle className="w-4 h-4" />}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground truncate">
                  {log.username}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium flex-shrink-0 ${
                  log.success
                    ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                    : "text-red-400 bg-red-500/10 border-red-500/30"
                }`}>
                  {log.success ? "Exitoso" : (FAIL_LABEL[log.failReason ?? ""] ?? "Fallido")}
                </span>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                {/* Dispositivo + navegador */}
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <DeviceIcon device={log.device} />
                  {log.browser} · {log.os}
                </span>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                {/* IP */}
                <span className="text-[11px] text-muted-foreground font-mono bg-secondary/40 px-1.5 py-0.5 rounded">
                  {log.ip}
                </span>
                {/* Fecha */}
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                  <Clock className="w-3 h-3" />
                  {formatDate(log.at)}
                </span>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
