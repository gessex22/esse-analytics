import { useState, useEffect, useCallback } from "react";
import { CheckCircle2, Loader2, Unlink, Link2 } from "lucide-react";
import { oauthService, setupService, ConnectPlatform, OAuthAccountInfo } from "../services/api";
import { PLATFORMS, AccountCardSkeleton } from "./YoutubeUploadView";

interface CardState {
  connected: boolean | null; // null = todavía consultando
  info: OAuthAccountInfo | null;
  busy: boolean;
  error: string | null;
}

function PlatformAccountCard({
  platform, label, color, Icon, active, disableToggle, onToggleActive,
}: {
  platform: ConnectPlatform;
  label: string;
  color: string;
  Icon: (p: { className?: string }) => JSX.Element;
  active: boolean;
  disableToggle: boolean;
  onToggleActive: () => void;
}) {
  const [state, setState] = useState<CardState>({ connected: null, info: null, busy: false, error: null });

  const refresh = useCallback(async () => {
    try {
      const { connected } = await oauthService.getStatus(platform);
      setState((s) => ({ ...s, connected, info: connected ? s.info : null }));
      if (connected) {
        const info = await oauthService.getAccountInfo(platform).catch(() => null);
        setState((s) => ({ ...s, info }));
      }
    } catch {
      setState((s) => ({ ...s, connected: false }));
    }
  }, [platform]);

  useEffect(() => { refresh(); }, [refresh]);

  // Mismo patrón que YoutubeUploadView/SimpleUploadView: TikTok/Instagram avisan
  // por postMessage desde el popup; YouTube redirige la página entera (Google no
  // deja completar el consentimiento en popup embebido) y vuelve con el query
  // param — por eso también se revisa acá, no solo en el listener de mensajes.
  useEffect(() => {
    const source = `${platform}_auth`;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.source !== source) return;
      if (e.data.status === "success") refresh();
      else setState((s) => ({ ...s, error: "No se pudo conectar. Intentá de nuevo." }));
    };
    window.addEventListener("message", onMsg);

    const params = new URLSearchParams(window.location.search);
    if (params.get(source) === "success") {
      refresh();
      window.history.replaceState({}, "", window.location.pathname);
    }
    return () => window.removeEventListener("message", onMsg);
  }, [platform, refresh]);

  const connect = async () => {
    setState((s) => ({ ...s, error: null }));
    const { url } = await oauthService.getAuthUrl(platform, window.location.origin);

    if (platform === "youtube") {
      window.location.href = url;
      return;
    }

    const w = 600, h = 720;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top  = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(url, `${platform}_oauth`, `width=${w},height=${h},left=${left},top=${top}`);
    if (popup) {
      const poll = setInterval(() => { if (popup.closed) { clearInterval(poll); refresh(); } }, 500);
    } else {
      // Sin ventana real detectable (Electron empaquetado) — reintenta en el
      // fondo hasta ver la conexión reflejada, en vez de depender del cierre.
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const ok = await oauthService.getStatus(platform).then((d) => d.connected).catch(() => false);
        if (ok || attempts >= 40) { clearInterval(poll); if (ok) refresh(); }
      }, 3000);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(`¿Desconectar tu cuenta de ${label}? Vas a tener que volver a vincularla para publicar ahí.`)) return;
    setState((s) => ({ ...s, busy: true }));
    try {
      await oauthService.disconnect(platform);
      setState({ connected: false, info: null, busy: false, error: null });
    } catch (err: any) {
      setState((s) => ({ ...s, busy: false, error: err.message || "Error al desconectar" }));
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className={`w-5 h-5 flex-shrink-0 ${color}`} />
          <span className="text-sm font-semibold text-foreground">{label}</span>
        </div>
        <label
          className={`flex items-center gap-2 select-none flex-shrink-0 ${disableToggle ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
          title={disableToggle ? "Al menos una plataforma tiene que quedar activa" : undefined}
        >
          <span className="text-[11px] text-muted-foreground">Usar en la app</span>
          <input
            type="checkbox"
            checked={active}
            disabled={disableToggle}
            onChange={onToggleActive}
            className="accent-primary"
          />
        </label>
      </div>

      {state.connected === null ? (
        <AccountCardSkeleton />
      ) : state.connected ? (
        state.info ? (
          <div className="flex items-center gap-3">
            {state.info.avatarUrl ? (
              <img src={state.info.avatarUrl} alt="" className="w-9 h-9 rounded-full flex-shrink-0 object-cover" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-secondary flex-shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground truncate flex items-center gap-1.5">
                {state.info.displayName || "Cuenta conectada"}
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
              </p>
              {state.info.handle && (
                <p className="text-xs text-muted-foreground truncate">@{state.info.handle.replace(/^@/, "")}</p>
              )}
            </div>
            <button
              onClick={disconnect}
              disabled={state.busy}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-400 transition-colors px-2 py-1 rounded-lg disabled:opacity-50 flex-shrink-0"
            >
              {state.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Unlink className="w-3.5 h-3.5" />}
              Desconectar
            </button>
          </div>
        ) : (
          <AccountCardSkeleton />
        )
      ) : (
        <button
          onClick={connect}
          className="w-full flex items-center justify-center gap-2 text-sm bg-primary/10 hover:bg-primary/20 text-primary px-3 py-2 rounded-lg transition-colors"
        >
          <Link2 className="w-4 h-4" />
          Conectar cuenta de {label}
        </button>
      )}

      {platform === "instagram" && (
        <p className="text-[11px] text-muted-foreground/70 border-t border-border pt-2.5">
          El cross-post a Facebook (checkbox aparte al subir un Reel) usa esta misma conexión —
          necesita que la cuenta de Instagram tenga una Página de Facebook vinculada.
        </p>
      )}

      {state.error && <p className="text-[11px] text-red-400">{state.error}</p>}
    </div>
  );
}

export function AccountsPanel() {
  const [active, setActive] = useState<ConnectPlatform[] | null>(null);

  useEffect(() => {
    setupService.getActivePlatforms()
      .then((d) => setActive(d.activePlatforms))
      .catch(() => setActive(["youtube", "instagram", "tiktok"]));
  }, []);

  const toggle = async (p: ConnectPlatform) => {
    if (!active) return;
    const wasActive = active.includes(p);
    if (wasActive && active.length === 1) return; // guard extra, el checkbox ya se deshabilita
    const next = wasActive ? active.filter((x) => x !== p) : [...active, p];
    setActive(next); // optimista
    try {
      await setupService.setActivePlatforms(next);
    } catch {
      setActive(active); // revert si falla el guardado
    }
  };

  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Cuentas conectadas</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Vinculá tus redes acá en vez de en la pantalla de Subir, y elegí cuáles usar —
          las que desactives dejan de aparecer en Subir y en los badges de Videos.
        </p>
      </div>

      {active === null ? (
        <>
          <AccountCardSkeleton />
          <AccountCardSkeleton />
          <AccountCardSkeleton />
        </>
      ) : (
        PLATFORMS.map((p) => (
          <PlatformAccountCard
            key={p.key}
            platform={p.key}
            label={p.label}
            color={p.color}
            Icon={p.Icon}
            active={active.includes(p.key)}
            disableToggle={active.length === 1 && active.includes(p.key)}
            onToggleActive={() => toggle(p.key)}
          />
        ))
      )}
    </div>
  );
}
