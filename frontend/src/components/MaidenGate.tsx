import { useEffect, useState } from "react";
import { Download, Sparkles } from "lucide-react";
import { API_BASE as API } from "../config";

export interface MaidenStatus {
  active: boolean;
  installed: boolean;
  running: boolean;
}

type GemStatus = "not_installed" | "installed" | "running";

// Hook: consulta si el plugin Maiden (agrupador de ideas) está instalado/corriendo.
// El Taller depende de que Maiden haya agrupado ideas, no de esse-Transcrip directamente.
export function useMaidenStatus() {
  const [status, setStatus]   = useState<MaidenStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const fetchStatus = () => {
      fetch(`${API}/api/gems`)
        .then(r => r.json())
        .then((gems: { id: string; status: GemStatus }[]) => {
          if (!alive) return;
          const gemStatus = gems.find(g => g.id === "esse_maiden")?.status ?? "not_installed";
          setStatus({
            active:    gemStatus !== "not_installed",
            installed: gemStatus !== "not_installed",
            running:   gemStatus === "running",
          });
        })
        .catch(() => { if (alive) setStatus({ active: false, installed: false, running: false }); })
        .finally(() => { if (alive) setLoading(false); });
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return { status, loading };
}

// Banner que se muestra cuando Maiden NO está instalado
export function MaidenRequired({ feature }: { feature?: string }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-6 sm:p-8 max-w-xl mx-auto text-center space-y-4">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
        <Sparkles className="w-7 h-7 text-primary" />
      </div>
      <div>
        <h3 className="text-lg font-semibold text-foreground">Se necesita Maiden</h3>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {feature
            ? `${feature} usa ideas agrupadas con IA. `
            : "Esta sección usa ideas agrupadas con IA. "}
          Instalá el plugin <span className="text-foreground font-medium">Maiden</span> desde Gemas para que agrupe automáticamente los videos que repiten la misma idea.
        </p>
      </div>
      <a
        href="#"
        onClick={(e) => e.preventDefault()}
        className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors"
      >
        <Download className="w-4 h-4" />
        Ir a Gemas
      </a>
      <p className="text-[11px] text-muted-foreground/60">
        El resto de la app (publicar, calendario, analíticas) funciona sin este componente.
      </p>
    </div>
  );
}
