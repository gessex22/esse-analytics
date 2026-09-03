import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.headers['x-request-id'];
  const requestId = typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    logger.info('http_request', {
      requestId,
      method: req.method,
      endpoint: req.route?.path || 'unmatched',
      status: res.statusCode,
      latencyMs: Math.round(latencyMs * 10) / 10,
    });
  });
  next();
}

// Muchos controladores legacy capturan sus propios errores. Esta última barrera
// garantiza que ninguna respuesta 5xx exponga err.message, stack o rutas físicas
// cuando el proceso corre en producción.
export function sanitizeProductionErrors(_req: Request, res: Response, next: NextFunction): void {
  if (!env.IS_PRODUCTION) {
    next();
    return;
  }
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 500) {
      return originalJson({ message: 'Error interno.', requestId: res.locals.requestId });
    }
    return originalJson(body);
  }) as Response['json'];
  next();
}
