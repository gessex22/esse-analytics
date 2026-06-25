import { Router, Request, Response, NextFunction } from 'express';

const router = Router();

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

async function proxyToCentral(req: Request, res: Response, _next: NextFunction) {
  const url = `${CENTRAL}${req.originalUrl}`;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;

    const init: RequestInit = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, init);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ message: 'Central no disponible', detail: err.message });
  }
}

// Express 5: router.use sin wildcard captura cualquier subruta
router.use('/api/auth', proxyToCentral);

export default router;
