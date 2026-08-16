import { useEffect, useState } from "react";
import { API_BASE, IS_LAN_CLIENT } from "../config";

// Solo tiene sentido cuando este frontend habla con el local-backend de OTRA
// PC (Opción C, cliente LAN) -- si la PC principal se apaga o el WiFi cae a
// mitad de sesión, sin esto cada fetch individual fallaría por separado con
// su propio mensaje (o peor, quedaría un spinner colgado si esa vista no
// maneja el error), sin ningún aviso global de "perdiste la conexión con la
// PC". Mismo criterio que ServerHealthCheck en ServerSettingsView.swift
// (GET /api/health), pero como poll continuo en vez de un chequeo puntual.
//
// Fuera de modo LAN (IS_LAN_CLIENT === false, el 100% de los casos hoy)
// siempre devuelve reachable:true y no arranca ningún poll -- cero costo/
// side-effects para el caso normal.
export function useServerReachability(intervalMs = 15000): { reachable: boolean; retry: () => void } {
  const [reachable, setReachable] = useState(true);

  const check = () => {
    fetch(`${API_BASE}/api/health`, { cache: "no-store" })
      .then(r => setReachable(r.ok))
      .catch(() => setReachable(false));
  };

  useEffect(() => {
    if (!IS_LAN_CLIENT) return;
    check();
    const id = setInterval(check, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return { reachable: IS_LAN_CLIENT ? reachable : true, retry: check };
}
