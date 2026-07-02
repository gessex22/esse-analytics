import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface PluginProgress {
  phase: string;
  current?: number;
  total?: number;
  title?: string;
}

export interface PluginActivity extends PluginProgress {
  id: string;
}

const PHASE_LABELS: Record<string, string> = {
  scanning:      "Escaneando videos",
  loading_model: "Cargando modelo",
  transcribing:  "Transcribiendo",
  matching:      "Comparando con ideas existentes",
  grouping:      "Agrupando ideas",
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** Poll liviano de /api/gems para saber si algún plugin está corriendo y con qué progreso.
 * Solo tiene sentido en modo local — /api/gems no existe en la central. */
export function usePluginActivity(enabled: boolean = true) {
  const [activity, setActivity] = useState<PluginActivity | null>(null);

  useEffect(() => {
    if (!enabled) { setActivity(null); return; }
    let alive = true;
    const poll = () => {
      fetch(`${API_BASE}/api/gems`)
        .then(r => r.json())
        .then((gems: { id: string; status: string; progress?: PluginProgress }[]) => {
          if (!alive) return;
          const active = gems.find(g => g.status === "running" && g.progress);
          setActivity(active ? { id: active.id, ...active.progress! } : null);
        })
        .catch(() => { if (alive) setActivity(null); });
    };
    poll();
    const id = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [enabled]);

  return activity;
}
