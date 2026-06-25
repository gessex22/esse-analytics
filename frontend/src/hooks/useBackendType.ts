import { useEffect, useState } from "react";
import { API_BASE } from "../config";

type BackendType = "local" | "central" | "unknown";

let cached: BackendType | null = null;

export function useBackendType(): { isLocal: boolean; isReady: boolean } {
  const [type, setType] = useState<BackendType>(cached ?? "unknown");

  useEffect(() => {
    if (cached !== null) { setType(cached); return; }
    fetch(`${API_BASE}/api/local/health`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const t: BackendType = d?.local === true ? "local" : "central";
        cached = t;
        setType(t);
      })
      .catch(() => { cached = "central"; setType("central"); });
  }, []);

  return { isLocal: type === "local", isReady: type !== "unknown" };
}
