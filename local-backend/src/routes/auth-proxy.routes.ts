import { Router, Request, Response, NextFunction } from 'express';
import { configRepo } from '../db/config.repo';
import { getOrCreateInstallId, getOrCreateDeviceName } from './local-admin.routes';
import { CENTRAL_API } from '../config';

const router = Router();

const CENTRAL = CENTRAL_API;
// Identifica a este cliente instalado ante la central (habilita el registro).
// El valor real lo inyecta el Electron (setupEnv) / dev .env; fallback solo de desarrollo.
const CLIENT_REGISTER_KEY = process.env.CLIENT_REGISTER_KEY || 'dev-only-not-a-real-key';

// Rutas destructivas que exigen el secreto de instalación de esta máquina.
const INSTALL_SECRET_ROUTES = ['/api/auth/local-reset', '/api/auth/local-deactivate'];

// Fase 5 (auditoría): estas rutas necesitan saber QUÉ instalación las llama
// para que la central pueda armar el evento con installationId/deviceName.
// Se inyecta acá, en el proxy -- nunca en el frontend -- mismo criterio que
// install_id para las rutas destructivas de arriba (aunque deviceName/source
// no son secretos, mantenerlos en un solo lugar evita que cada vista del
// frontend tenga que saber de esto). getAuthUrl es GET (installationId viaja
// en el state de OAuth, ver oauth-state.ts en el backend); revokeAuth es
// DELETE (sin body real); login es POST normal.
const DEVICE_IDENTITY_QUERY_ROUTES = [
  '/api/youtube/auth/url', '/api/youtube/auth' /* DELETE = revoke */,
  '/api/instagram/auth/url', '/api/instagram/auth',
  '/api/tiktok/auth/url', '/api/tiktok/auth',
];

function withDeviceIdentityQuery(url: string): string {
  const u = new URL(url);
  u.searchParams.set('installationId', getOrCreateInstallId());
  u.searchParams.set('deviceName', getOrCreateDeviceName());
  u.searchParams.set('source', 'desktop');
  return u.toString();
}

async function proxyToCentral(req: Request, res: Response, _next: NextFunction) {
  let url = `${CENTRAL}${req.originalUrl}`;
  // req.originalUrl trae querystring (origin/client que ya manda el cliente
  // para getAuthUrl) -- se compara solo la parte de path, y EXACTA (no
  // startsWith) para no capturar /auth/callback ni /auth/status, que no
  // necesitan esto.
  const requestPath = req.originalUrl.split('?')[0];
  if (
    (req.method === 'GET' && DEVICE_IDENTITY_QUERY_ROUTES.some(r => r.endsWith('/url') && requestPath === r)) ||
    (req.method === 'DELETE' && DEVICE_IDENTITY_QUERY_ROUTES.some(r => !r.endsWith('/url') && requestPath === r))
  ) {
    url = withDeviceIdentityQuery(url);
  }
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Client-Key': CLIENT_REGISTER_KEY,
    };
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;

    const init: RequestInit = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Inyecta el secreto de instalación desde SQLite — nunca pasa por el frontend.
      const body = { ...req.body };
      if (INSTALL_SECRET_ROUTES.some(r => req.originalUrl.startsWith(r))) {
        body.installId = configRepo.get('install_id') ?? undefined;
      }
      // Identidad de dispositivo para el evento de auditoría de login (Fase 5)
      // -- mismo criterio que arriba, nunca la manda el frontend.
      if (requestPath === '/api/auth/login') {
        body.installationId = getOrCreateInstallId();
        body.deviceName = getOrCreateDeviceName();
        body.source = 'desktop';
      }
      init.body = JSON.stringify(body);
    }

    const upstream = await fetch(url, init);
    const ct = upstream.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      // La central devolvió HTML (ruta no encontrada o error de servidor)
      const text = await upstream.text();
      res.status(upstream.status).json({ message: `Error en central (${upstream.status})`, detail: text.slice(0, 200) });
      return;
    }
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ message: 'Central no disponible', detail: err.message });
  }
}

// Auth central
router.use('/api/auth', proxyToCentral);

// OAuth de plataformas — callbacks registrados en la central, tokens guardados allá
router.use('/api/youtube/auth',         proxyToCentral);
router.use('/api/youtube/channel-info', proxyToCentral);
router.use('/api/youtube/token',        proxyToCentral);
router.use('/api/tiktok/auth',          proxyToCentral);
router.use('/api/tiktok/creator-info',  proxyToCentral);
router.use('/api/instagram/auth',       proxyToCentral);
router.use('/api/instagram/account-info', proxyToCentral);

// Backup en línea — los endpoints de cloud viven en la central
router.use('/api/backup', proxyToCentral);

// Tokens OAuth — la central los custodia, el local-backend los pide para subir directo
router.use('/api/tiktok/token',     proxyToCentral);
router.use('/api/instagram/token',  proxyToCentral);

// Calendario — la config vive en MongoDB (central), no en SQLite
router.use('/api/sync/calendar-config', proxyToCentral);

// Sincronización (match YouTube↔archivo local y emparejado entre plataformas) —
// vive en Mongo/central, no en SQLite. Sin esto, estas rutas no matcheaban nada
// local y caían en el catch-all de frontend estático (devolvía HTML en vez de
// proxyar), rompiendo el panel de Sincronización cuando se usa desde la app.
router.use('/api/sync/stats',           proxyToCentral);
router.use('/api/sync/review',          proxyToCentral);
router.use('/api/sync/youtube',         proxyToCentral);
router.use('/api/sync/platform-recent', proxyToCentral);
router.use('/api/sync/cross-match',     proxyToCentral);
// Estadísticas se resuelven en SQLite local (sync.routes se registra después):
// así las pestañas individuales usan el historial más reciente de publicaciones
// de esta PC. Si se proxya antes, la central responde solo grupos matcheados.
router.use('/api/sync/file-stats',      proxyToCentral);

// Auditoría (Fase 5) — el log de eventos vive en Mongo/central (es cross-
// dispositivo), no en SQLite. Sin esto cae en el catch-all de frontend
// estático y ActivityView revienta con "Unexpected token '<'" al parsear
// HTML como si fuera JSON (mismo bug que ya pasó con /api/sync/*).
router.use('/api/audit-events', proxyToCentral);

export default router;
