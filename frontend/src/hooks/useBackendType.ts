import { useEffect, useState } from "react";
import { API_BASE } from "../config";

type BackendType = "local" | "central" | "unknown";

let cached: BackendType | null = null;
// labMode viaja en el mismo /api/local/health que ya se pedía para lo de
// arriba -- separado del cache de `type` porque solo tiene sentido cuando
// `type === "local"` (la central real nunca es Laboratorio) y así no hace
// falta invalidar nada si algún día vuelve a pedirse.
let cachedLabMode = false;

export function useBackendType(): { isLocal: boolean; isReady: boolean; isLabMode: boolean } {
  const [type, setType] = useState<BackendType>(cached ?? "unknown");
  const [labMode, setLabMode] = useState(cachedLabMode);

  useEffect(() => {
    if (cached !== null) { setType(cached); setLabMode(cachedLabMode); return; }
    fetch(`${API_BASE}/api/local/health`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const t: BackendType = d?.local === true ? "local" : "central";
        cached = t;
        cachedLabMode = d?.labMode === true;
        setType(t);
        setLabMode(cachedLabMode);
      })
      .catch(() => { cached = "central"; setType("central"); });
  }, []);

  return { isLocal: type === "local", isReady: type !== "unknown", isLabMode: labMode };
}
