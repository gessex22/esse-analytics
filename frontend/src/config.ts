const host = window.location.hostname;

// Regla simple y robusta:
// - El sitio público (Cloudflare Pages, esse-analytics.com) habla con la CENTRAL.
// - Cualquier otra cosa (Electron en localhost:4000, LAN IP:4000, o el túnel
//   app.esse-analytics.com → :4000) fue servida por un backend LOCAL → habla consigo misma.
// Así funciona LAN en cualquier rango de IP y el acceso remoto por túnel sin casos especiales.
const isCloudflarePages = host === 'esse-analytics.com' || host === 'www.esse-analytics.com';

export const API_BASE = isCloudflarePages
  ? 'https://api.esse-analytics.com'
  : window.location.origin;
