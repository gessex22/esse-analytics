import { useEffect, useRef } from "react";
import { backupService } from "../services/api";
import { API_BASE } from "../config";

const INTERVAL_MS = 15 * 60 * 1000; // cada 15 minutos
const MIN_GAP_MS  = 5 * 60 * 1000;  // no pushear más seguido que cada 5 min

/**
 * Backup automático (premium): respalda los metadatos del SQLite local en la nube.
 * - Solo corre en el dispositivo central (isLocal) y para usuarios premium.
 * - Push al montar, cada 15 min, y al cerrar la app/pestaña.
 * Así la nube (y el catálogo que se ve en remoto) se mantiene fresca sin acción manual.
 */
export function useAutoBackup(enabled: boolean) {
  const lastPush = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const doPush = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastPush.current < MIN_GAP_MS) return;
      lastPush.current = now;
      try { await backupService.push(); } catch { /* silencioso: no molestar */ }
    };

    // Push inicial al abrir (captura cambios hechos con la app cerrada)
    const startTimer = setTimeout(() => { if (!cancelled) doPush(true); }, 4000);

    // Push periódico
    const interval = setInterval(() => { if (!cancelled) doPush(); }, INTERVAL_MS);

    // Push final al cerrar (deja la nube fresca al salir)
    const onLeave = () => {
      const token = localStorage.getItem("esse_auth_token");
      if (!token) return;
      // sendBeacon no permite headers; usamos fetch keepalive con el token
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
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [enabled]);
}
