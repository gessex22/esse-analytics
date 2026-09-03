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
//
// Es un parche de transporte, no la corrección de fondo -- la corrección real
// es migrar los ~75 sitios `catch (err) { res.status(500).json({error: err.message}) }`
// a `catch (err) { next(err) }` para que lleguen de verdad a errorHandler
// (error.middleware.ts), que hoy nunca se ejecuta (0 controladores llaman
// next(err)). Eso es un refactor grande, deliberadamente fuera de esta
// entrega -- lo que sí se corrigió acá: cubrir también res.send (antes solo
// se parchaba res.json, dejando pasar cualquier 500 armado con res.send) y
// hacerlo testeable de verdad (ver security.test.ts) en vez de depender de
// NODE_ENV=production real para poder probarlo.
//
// sanitizeErrorsIf(isProduction) es la función pura, inyectable en tests;
// sanitizeProductionErrors (abajo) es la instancia real que usa server.ts,
// atada al env.IS_PRODUCTION congelado del proceso real.
export function sanitizeErrorsIf(isProduction: boolean) {
  return function sanitizeErrorsMiddleware(_req: Request, res: Response, next: NextFunction): void {
    if (!isProduction) {
      next();
      return;
    }
    const sanitizedBody = () => ({ message: 'Error interno.', requestId: res.locals.requestId });
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      return res.statusCode >= 500 ? originalJson(sanitizedBody()) : originalJson(body);
    }) as Response['json'];
    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      return res.statusCode >= 500 ? originalSend(JSON.stringify(sanitizedBody())) : originalSend(body as any);
    }) as Response['send'];
    next();
  };
}

export const sanitizeProductionErrors = sanitizeErrorsIf(env.IS_PRODUCTION);
