const host = window.location.hostname;

// Regla simple y robusta:
// - El sitio público (Cloudflare Pages, esse-analytics.com) habla con la CENTRAL.
// - Cualquier otra cosa (Electron en localhost:4000, LAN IP:4000, o el túnel
//   app.esse-analytics.com → :4000) fue servida por un backend LOCAL → habla consigo misma.
// Así funciona LAN en cualquier rango de IP y el acceso remoto por túnel sin casos especiales.
const isCloudflarePages = host === 'esse-analytics.com' || host === 'www.esse-analytics.com';

// ── Cliente LAN de otra instalación (Opción C, docs/single-primary-install-plan-2026-08-14.md) ──
// Un Electron "secundario" puede apuntar su frontend al local-backend de OTRA
// instalación Electron ("primaria") en la misma red, en vez de al propio --
// mismo patrón que ServerSettingsView.swift/CentralAPI.customServerURLString
// ya prueban en producción del lado iOS. La preferencia se persiste en
// localStorage (no en SQLite: es una preferencia de ESTE navegador/ventana de
// Electron, no de la cuenta) y se lee UNA sola vez al cargar el módulo -- el
// resto de la app (frontend/src/services/api.ts entero importa API_BASE de
// acá) no necesita saber que existe un override. Cambiarlo requiere recargar
// la página (ver setServerOverride) para que este módulo se re-evalúe.
const OVERRIDE_URL_KEY  = 'esse_server_override_url';
const OVERRIDE_MODE_KEY = 'esse_server_override_mode'; // solo 'lan' por ahora

function readOverrideUrl(): string | null {
  try {
    if (localStorage.getItem(OVERRIDE_MODE_KEY) !== 'lan') return null;
    const url = localStorage.getItem(OVERRIDE_URL_KEY);
    return url ? url.replace(/\/+$/, '') : null;
  } catch {
    // localStorage puede no estar disponible (ej. algún webview restringido) --
    // sin override en ese caso, nunca debe tirar la carga de la app.
    return null;
  }
}

const overrideUrl = readOverrideUrl();

export const API_BASE = overrideUrl
  ? overrideUrl
  : isCloudflarePages
    ? 'https://api.esse-analytics.com'
    : window.location.origin;

// true solo cuando este frontend está hablando con el local-backend de OTRA
// PC por LAN (no la que lo sirve a él mismo). Distinto de `isLocal` en
// useBackendType (que solo pregunta "¿el backend activo es local-backend o
// central?", true en ambos casos acá) -- esto existe para ocultar lo que
// depende del DISCO/CARPETA de ESTA instalación puntual (scan, video_folder,
// watcher, wipe), que no tiene sentido -- y es peligroso -- controlar a
// distancia sobre la PC de otra persona. Ver App.tsx/SettingsView.tsx.
export const IS_LAN_CLIENT = !!overrideUrl;

// Solo informativo para la UI (badge "Conectado a <url>") -- no afecta nada más.
export const LAN_SERVER_URL = overrideUrl;

// Persiste (o limpia) el override y fuerza un reload para que todo el módulo
// (y por lo tanto toda la app, que importa API_BASE de acá) se re-evalúe con
// el nuevo valor. No intenta ser "reactivo" en caliente a propósito: mismo
// criterio que ServerSettingsView.swift, que además invalida la sesión activa
// al cambiar de servidor (un JWT de un backend no vale para otro) -- eso lo
// hace el caller (ver ServerConnectionPanel.tsx) ANTES de llamar a esto.
export function setServerOverride(url: string | null): void {
  try {
    if (url) {
      localStorage.setItem(OVERRIDE_URL_KEY, url.replace(/\/+$/, ''));
      localStorage.setItem(OVERRIDE_MODE_KEY, 'lan');
    } else {
      localStorage.removeItem(OVERRIDE_URL_KEY);
      localStorage.removeItem(OVERRIDE_MODE_KEY);
    }
  } catch {
    // Sin localStorage no se puede persistir -- el caller igual recarga,
    // así que como mucho el override no sobrevive a esta sesión de ventana.
  }
}
