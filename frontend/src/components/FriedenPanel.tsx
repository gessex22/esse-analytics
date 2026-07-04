import { useCallback, useEffect, useState } from "react";
import { Globe, Cloud, Download, RefreshCw, Loader2 } from "lucide-react";
import { API_BASE } from "../config";
import { BackupPanel, FRIEDEN_MEMBERS } from "./GemsPanel";

type RemoteStatus = "not_installed" | "installed" | "running" | "loading";

// Acceso Remoto y Backup en línea funcionan por defecto (sin switch): Backup
// siempre respalda solo, y Acceso Remoto arranca solo si está instalado (ver
// local-backend/src/server.ts). Acá solo se ve su estado y se puede instalar
// el ejecutable de Acceso Remoto si todavía falta.
export function FriedenPanel() {
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus>("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/gems`);
      if (!res.ok) throw new Error();
      const data: { id: string; status: RemoteStatus }[] = await res.json();
      setRemoteStatus(data.find(d => d.id === "esse_remote_access")?.status ?? "not_installed");
    } catch {
      setRemoteStatus("not_installed");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remote = FRIEDEN_MEMBERS.esse_remote_access;
  const backup = FRIEDEN_MEMBERS.esse_backup;

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Remoto y Backup</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Acceso remoto a tu app y respaldo en la nube — funcionan por defecto, sin que tengas que activarlos.
        </p>
      </div>

      {/* Acceso Remoto */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-secondary flex-shrink-0">
            <Globe className="w-5 h-5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-foreground leading-tight">{remote.name}</p>
            <p className="text-xs text-muted-foreground">{remote.tagline}</p>
          </div>
          <button onClick={load} className="text-muted-foreground hover:text-foreground p-1 transition-colors flex-shrink-0" title="Refrescar estado">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{remote.description}</p>

        {remoteStatus === "loading" ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : remoteStatus === "not_installed" ? (
          <button
            onClick={() => alert(
              `Coloca el ejecutable en:\n~/.esse-analytics/gems/\n\nNombre del archivo:\n${
                navigator.platform.startsWith("Win") ? "esse_remote.exe" : "esse_remote"
              }`
            )}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Instalar
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Activo
          </span>
        )}
      </div>

      {/* Backup en línea */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-secondary flex-shrink-0">
            <Cloud className="w-5 h-5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-foreground leading-tight">{backup.name}</p>
            <p className="text-xs text-muted-foreground">{backup.tagline}</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{backup.description}</p>
        <BackupPanel />
      </div>
    </div>
  );
}
