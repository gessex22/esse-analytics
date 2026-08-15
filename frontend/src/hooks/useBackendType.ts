import { useEffect, useState } from "react";
import { API_BASE } from "../config";

type BackendType = "local" | "central" | "unknown";

let cached: BackendType | null = null;
// labMode viaja en el mismo /api/local/health que ya se pedía para lo de
// arriba -- separado del cache de `type` porque solo tiene sentido cuando
// `type === "local"` (la central real nunca es Laboratorio) y así no hace
// falta invalidar nada si algún día vuelve a pedirse.
let cachedLabMode = false;
// pendingHistoryEvents (BUG-2026-08-15-07): a diferencia de labMode, ESTE sí
// puede cambiar durante la sesión (se publica algo nuevo, o el outbox local
// termina de entregar lo pendiente) -- no se cachea "para siempre" como los
// de arriba, se relee en cada llamado a refreshBackendHealth().
let cachedPendingHistoryEvents = 0;

async function fetchHealth() {
  const d = await fetch(`${API_BASE}/api/local/health`, { cache: "no-store" })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  const t: BackendType = d?.local === true ? "local" : "central";
  cached = t;
  cachedLabMode = d?.labMode === true;
  cachedPendingHistoryEvents = typeof d?.pendingHistoryEvents === "number" ? d.pendingHistoryEvents : 0;
  return { type: t, labMode: cachedLabMode, pendingHistoryEvents: cachedPendingHistoryEvents };
}

export function useBackendType(): {
  isLocal: boolean;
  isReady: boolean;
  isLabMode: boolean;
  pendingHistoryEvents: number;
  refreshBackendHealth: () => void;
} {
  const [type, setType] = useState<BackendType>(cached ?? "unknown");
  const [labMode, setLabMode] = useState(cachedLabMode);
  const [pendingHistoryEvents, setPendingHistoryEvents] = useState(cachedPendingHistoryEvents);

  const refresh = () => {
    fetchHealth().then(r => {
      setType(r.type);
      setLabMode(r.labMode);
      setPendingHistoryEvents(r.pendingHistoryEvents);
    });
  };

  useEffect(() => {
    if (cached !== null) {
      setType(cached);
      setLabMode(cachedLabMode);
      setPendingHistoryEvents(cachedPendingHistoryEvents);
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isLocal: type === "local", isReady: type !== "unknown", isLabMode: labMode, pendingHistoryEvents, refreshBackendHealth: refresh };
}
