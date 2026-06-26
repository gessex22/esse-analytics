import { Router, Request, Response, NextFunction } from 'express';
import { configRepo } from '../db/config.repo';

const router = Router();

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';
// Identifica a este cliente instalado ante la central (habilita el registro).
// El valor real lo inyecta el Electron (setupEnv) / dev .env; fallback solo de desarrollo.
const CLIENT_REGISTER_KEY = process.env.CLIENT_REGISTER_KEY || 'dev-only-not-a-real-key';

// Rutas destructivas que exigen el secreto de instalación de esta máquina.
const INSTALL_SECRET_ROUTES = ['/api/auth/local-reset', '/api/auth/local-deactivate'];

async function proxyToCentral(req: Request, res: Response, _next: NextFunction) {
  const url = `${CENTRAL}${req.originalUrl}`;
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

export default router;
