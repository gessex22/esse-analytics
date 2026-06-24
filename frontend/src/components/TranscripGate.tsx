import { useEffect, useState } from "react";
import { Download, Loader2, Sparkles } from "lucide-react";
import { API_BASE as API } from "../config";

export interface TranscripStatus {
  active: boolean;
  lastHeartbeat: string | null;
  version: string | null;
  pending: number;
}

// Hook: consulta si esse-Transcrip está activo (revalida cada 30s)
export function useTranscripStatus() {
  const [status, setStatus]   = useState<TranscripStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const fetchStatus = () => {
      const token = localStorage.getItem("esse_auth_token");
      fetch(`${API}/api/components/transcrip`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
        .then(r => r.json())
        .then(d => { if (alive) setStatus(d); })
        .catch(() => { if (alive) setStatus({ active: false, lastHeartbeat: null, version: null, pending: 0 }); })
        .finally(() => { if (alive) setLoading(false); });
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return { status, loading };
}

// Banner que se muestra cuando esse-Transcrip NO está activo
export function TranscripRequired({ feature }: { feature?: string }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-6 sm:p-8 max-w-xl mx-auto text-center space-y-4">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
        <Sparkles className="w-7 h-7 text-primary" />
      </div>
      <div>
        <h3 className="text-lg font-semibold text-foreground">Se necesita esse-Transcrip</h3>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {feature
            ? `${feature} usa transcripción con IA. `
            : "Esta sección usa transcripción con IA. "}
          Para habilitarla, instalá y ejecutá el componente <span className="text-foreground font-medium">esse-Transcrip</span> en este equipo.
          Una vez activo, transcribe tus videos automáticamente y desbloquea esta función.
        </p>
      </div>
      <a
        href="#"
        onClick={(e) => e.preventDefault()}
        className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors"
      >
        <Download className="w-4 h-4" />
        Descargar esse-Transcrip
      </a>
      <p className="text-[11px] text-muted-foreground/60">
        El resto de la app (publicar, calendario, analíticas) funciona sin este componente.
      </p>
    </div>
  );
}

// Indicador chico de estado (para headers/esquinas)
export function TranscripBadge() {
  const { status, loading } = useTranscripStatus();
  if (loading) return <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />;
  if (!status) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full ${
      status.active ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-300"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status.active ? "bg-emerald-400" : "bg-amber-400"}`} />
      esse-Transcrip {status.active ? "activo" : "inactivo"}
    </span>
  );
}
