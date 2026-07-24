import { useEffect } from "react";
import { runSyncTick } from "../services/syncOrchestrator";
import { API_BASE } from "../config";

const FALLBACK_INTERVAL_MS = 20 * 60 * 1000; // red de seguridad; el foco/visibilidad cubre el caso común

/**
 * Sync automático (premium, dispositivo central): push + pull + precargado a
 * Biblioteca remota como una sola unidad (ver syncOrchestrator.ts), disparada
 * en los momentos en que de verdad puede haber algo nuevo para sincronizar —
 * no en un timer ciego. Reemplaza a useAutoBackup (solo pusheaba, y en un
 * timer aislado que no tenía forma de enterarse de si hacía falta o no).
 *
 * Disparadores: al montar (fuerza el primer tick), al recuperar foco/visibilidad
 * (volver a la ventana tras estar en otra app, o volver a esta pestaña), y un
 * fallback periódico bastante más espaciado que antes — el cooldown compartido
 * de runSyncTick evita que se dupare trabajo si dos disparadores caen juntos.
 */
export function useSyncOrchestrator(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const tick = (force = false) => { if (!cancelled) runSyncTick(force); };

    const startTimer = setTimeout(() => tick(true), 4000);
    const interval = setInterval(() => tick(), FALLBACK_INTERVAL_MS);

    const onFocus = () => tick();
    const onVisibility = () => { if (document.visibilityState === "visible") tick(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    // Al cerrar: solo push (best-effort, keepalive) — un tick completo async no
    // llega a terminar durante beforeunload, y dejar la nube fresca es lo que
    // más importa en ese momento.
    const onLeave = () => {
      const token = localStorage.getItem("esse_auth_token");
      if (!token) return;
      fetch(`${API_BASE}/api/local/backup/push`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("beforeunload", onLeave);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [enabled]);
}
