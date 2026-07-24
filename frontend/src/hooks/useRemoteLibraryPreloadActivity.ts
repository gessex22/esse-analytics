import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface RemoteLibraryPreloadActivity {
  title: string;
  phase: "uploading" | "error";
  message?: string;
}

/** Poll liviano de /api/remote-library-preload-status: precarga automática a
 * Biblioteca remota del "próximo a publicar" (almacenamiento dinámico -- el
 * cliente decide y sube, ver remote-library-preload.service.ts en local-backend).
 * Solo tiene sentido en modo local, igual que useUploadActivity. */
export function useRemoteLibraryPreloadActivity(enabled: boolean = true) {
  const [activity, setActivity] = useState<RemoteLibraryPreloadActivity | null>(null);

  useEffect(() => {
    if (!enabled) { setActivity(null); return; }
    let alive = true;
    const poll = () => {
      fetch(`${API_BASE}/api/remote-library-preload-status`)
        .then(r => r.json())
        .then((job: RemoteLibraryPreloadActivity | null) => { if (alive) setActivity(job); })
        .catch(() => { if (alive) setActivity(null); });
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [enabled]);

  return activity;
}
