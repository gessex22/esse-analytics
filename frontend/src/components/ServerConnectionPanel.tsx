import { useEffect, useState } from "react";
import { Wifi, Loader2, CheckCircle2, XCircle, Monitor, Router, RefreshCw } from "lucide-react";
import { API_BASE, IS_LAN_CLIENT, setServerOverride } from "../config";

// Selector de servidor para Electron -- mirror conceptual de
// ServerSettingsView.swift (essenalytics-ios), adaptado a que acá solo hace
// falta un selector binario (no hay modo "Laboratorio" visible en el build
// distribuido, y "Central" ya lo resuelve config.ts solo según el host que
// sirve el frontend -- eso nunca cambia acá, "Esta PC" siempre es
// window.location.origin).
//
// Reusable en dos contextos, igual que el original:
// 1. Desde Ajustes > Servidor, con sesión activa (SettingsView.tsx).
// 2. Desde un panel en LoginPage.tsx, SIN sesión -- resuelve el problema de
//    "no hay forma de loguearse contra la PC de otro antes de tener sesión".
//
// Conectar con éxito a un servidor DISTINTO al actual borra el token guardado
// y recarga la página: config.ts lee el override de localStorage una sola vez
// al cargar el módulo (no es reactivo en caliente), y un JWT emitido por un
// local-backend no tiene por qué validar en otro (ver auth.middleware.ts,
// JWT_SECRET es por proceso) -- mismo criterio que CentralAPI en iOS.
export function ServerConnectionPanel({ onConnected }: { onConnected?: () => void }) {
  const isElectron = !!window.electronAPI;

  const [mode, setMode] = useState<"self" | "lan">(IS_LAN_CLIENT ? "lan" : "self");
  const [lanUrlText, setLanUrlText] = useState(IS_LAN_CLIENT ? API_BASE : "");
  const [testState, setTestState] = useState<
    { kind: "idle" } | { kind: "testing" } | { kind: "success"; message: string } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredEsseServer[]>([]);

  const discover = () => {
    if (!isElectron) return;
    setDiscovering(true);
    window.electronAPI!.discoverServers()
      .then(setDiscovered)
      .catch(() => setDiscovered([]))
      .finally(() => setDiscovering(false));
  };

  // Busca automáticamente al entrar en modo "Otra PC" -- mismo criterio que
  // LocalPCDiscovery.start() en .onAppear del lado iOS.
  useEffect(() => {
    if (mode === "lan" && isElectron && discovered.length === 0 && !discovering) discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function normalizeUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!trimmed) return trimmed;
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  const connect = async () => {
    const target = mode === "self" ? window.location.origin : normalizeUrl(lanUrlText);
    if (mode === "lan" && !target) {
      setTestState({ kind: "error", message: "Ingresá una IP o elegí una PC de la lista." });
      return;
    }

    setTestState({ kind: "testing" });

    // Ya estás hablando con este mismo servidor -- no hace falta re-testear
    // ni tirar la sesión (evita un logout/reload molesto si el usuario abre
    // este panel solo para mirar y toca "Conectar" sin cambiar nada).
    if (target === API_BASE) {
      setTestState({ kind: "success", message: "Ya estás conectado acá." });
      return;
    }

    if (mode === "self") {
      // Volver a "esta PC" no necesita probar conexión (es el propio backend
      // que ya está sirviendo este frontend) -- solo limpiar el override.
      applyAndReload(null);
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      // FIX 2026-08-16 (Fase 5, docs/lan-library-auto-switch-design-2026-08-16.md):
      // antes pegaba a /api/local/health -- ese endpoint es para el AUTO-chequeo
      // del frontend contra SU PROPIO backend (useBackendType.ts: banner de
      // Laboratorio, pendingHistoryEvents), no para que un cliente ajeno
      // verifique "¿sos vos, EsseAnalytics?" de otra PC. /api/health
      // (server.ts) es el endpoint genérico de identidad+entorno, mismo que
      // ya usa ServerHealthCheck.swift en iOS -- alinea los dos clientes al
      // mismo contrato en vez de que cada uno pruebe algo distinto.
      const res = await fetch(`${target}/api/health`, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      if (data?.service !== "esse-local-backend") {
        setTestState({ kind: "error", message: "Esa dirección respondió, pero no es un local-backend de EsseAnalytics." });
        return;
      }
      setTestState({
        kind: "success",
        message: data.environment === "lab" ? "Conectado (Laboratorio -- datos simulados)." : "Conectado.",
      });
      applyAndReload(target);
    } catch (err: any) {
      const timedOut = err?.name === "AbortError";
      setTestState({
        kind: "error",
        message: timedOut
          ? `No respondió a tiempo (${target}). ¿Están en la misma red? ¿El firewall permite el puerto?`
          : `No se pudo conectar a ${target}.`,
      });
    }
  };

  function applyAndReload(target: string | null) {
    setServerOverride(target);
    // Un JWT de un backend no vale para otro (JWT_SECRET por proceso) --
    // se limpia ANTES de recargar para no mostrar una sesión inválida.
    localStorage.removeItem("esse_auth_token");
    onConnected?.();
    window.location.reload();
  }

  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Router className="w-4 h-4" /> Servidor
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          A qué PC le habla esta instalación. Cambiar de servidor cierra la sesión actual.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
        Conectado ahora a: <span className="text-foreground font-mono">{API_BASE}</span>
        {IS_LAN_CLIENT && <span className="ml-1.5 text-primary">(otra PC, por LAN)</span>}
      </div>

      <div className="space-y-2">
        <button
          onClick={() => { setMode("self"); setTestState({ kind: "idle" }); }}
          className={`w-full flex items-center gap-3 text-left px-4 py-3 rounded-xl border transition-colors ${
            mode === "self" ? "border-primary/50 bg-primary/5" : "border-border hover:bg-secondary/40"
          }`}
        >
          <Monitor className={`w-4 h-4 flex-shrink-0 ${mode === "self" ? "text-primary" : "text-muted-foreground"}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Esta PC</p>
            <p className="text-xs text-muted-foreground">Usar la biblioteca y el catálogo de esta instalación (normal).</p>
          </div>
        </button>

        <button
          onClick={() => { setMode("lan"); setTestState({ kind: "idle" }); }}
          className={`w-full flex items-center gap-3 text-left px-4 py-3 rounded-xl border transition-colors ${
            mode === "lan" ? "border-primary/50 bg-primary/5" : "border-border hover:bg-secondary/40"
          }`}
        >
          <Wifi className={`w-4 h-4 flex-shrink-0 ${mode === "lan" ? "text-primary" : "text-muted-foreground"}`} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Otra PC en la red</p>
            <p className="text-xs text-muted-foreground">Conectar directo al local-backend de otra instalación, por LAN.</p>
          </div>
        </button>
      </div>

      {mode === "lan" && (
        <div className="space-y-2 pl-1">
          {isElectron && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">PCs encontradas en la red</span>
                <button
                  onClick={discover}
                  disabled={discovering}
                  className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                >
                  {discovering ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Buscar
                </button>
              </div>
              {discovering && discovered.length === 0 && (
                <p className="text-xs text-muted-foreground">Buscando PCs en la red…</p>
              )}
              {!discovering && discovered.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Ninguna encontrada todavía. La otra PC tiene que estar prendida, con EsseAnalytics abierto, en la misma red WiFi.
                </p>
              )}
              {discovered.map((s) => {
                const url = `http://${s.host}:${s.port}`;
                const selected = normalizeUrl(lanUrlText) === url;
                return (
                  <button
                    key={url}
                    onClick={() => setLanUrlText(url)}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${
                      selected ? "border-primary/50 bg-primary/5" : "border-border hover:bg-secondary/40"
                    }`}
                  >
                    <Monitor className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-foreground truncate">{s.name}{s.labMode ? " · Laboratorio" : ""}</p>
                      <p className="text-[11px] text-muted-foreground font-mono">{url}</p>
                    </div>
                    {selected && <CheckCircle2 className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}

          <label className="text-xs font-medium text-muted-foreground">Dirección manual</label>
          <input
            value={lanUrlText}
            onChange={(e) => setLanUrlText(e.target.value)}
            placeholder="192.168.1.50:4000"
            className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            La otra PC y esta tienen que estar en la misma red. Si no aparece en la búsqueda, permití EsseAnalytics
            en el firewall de Windows para el puerto 4000, o pedí la IP directamente.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={connect}
          disabled={testState.kind === "testing"}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
        >
          {testState.kind === "testing" ? "Probando…" : "Conectar"}
        </button>

        {testState.kind === "testing" && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Probando…
          </span>
        )}
        {testState.kind === "success" && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" /> {testState.message}
          </span>
        )}
        {testState.kind === "error" && (
          <span className="flex items-center gap-1.5 text-xs text-red-400">
            <XCircle className="w-3.5 h-3.5" /> {testState.message}
          </span>
        )}
      </div>
    </div>
  );
}
