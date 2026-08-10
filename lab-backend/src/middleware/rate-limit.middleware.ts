import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

export interface RateLimitEvent {
  scope: 'login' | 'register' | 'api';
  ip: string;
  at: string;
  retryAfterSeconds: number | null;
}

const blockedEvents: RateLimitEvent[] = [];
const keyEpoch = new Map<string, number>();

function keyFor(ip: string): string {
  return `${ip}:${keyEpoch.get(ip) ?? 0}`;
}

function onRateLimit(scope: RateLimitEvent['scope']) {
  return (req: Request, res: Response, _next: NextFunction, options: { statusCode: number; message: unknown }): void => {
    const resetTime = (req as any).rateLimit?.resetTime as Date | undefined;
    blockedEvents.unshift({
      scope,
      ip: req.ip,
      at: new Date().toISOString(),
      retryAfterSeconds: resetTime ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : null,
    });
    if (blockedEvents.length > 50) blockedEvents.pop();
    res.status(options.statusCode).json(options.message);
  };
}

export function getRateLimitEvents(): RateLimitEvent[] {
  return blockedEvents;
}

// Solo para el panel del Laboratorio. Cambia el namespace de la IP actual en
// los stores en memoria; no existe en la central ni afecta cuentas reales.
export function resetRateLimitsForIp(ip: string): void {
  keyEpoch.set(ip, (keyEpoch.get(ip) ?? 0) + 1);
}

// Mismos límites que backend/src/middleware/rate-limit.middleware.ts (la
// central real) -- el Laboratorio corre expuesto en la LAN sin ninguna otra
// protección (no hay CLIENT_REGISTER_KEY que valga acá, cualquiera en la
// misma Wi-Fi puede pegarle), así que no tener ESTO también sería un hueco
// de seguridad real, no solo de paridad de contrato.

// Máximo 10 intentos de login por IP en 15 minutos.
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' },
  skipSuccessfulRequests: true, // los logins exitosos no consumen el límite
  keyGenerator: (req) => keyFor(req.ip),
  handler: onRateLimit('login'),
});

// Registro: máximo 5 cuentas por IP por hora.
export const registerRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados registros desde esta red. Intenta más tarde.' },
  keyGenerator: (req) => keyFor(req.ip),
  handler: onRateLimit('register'),
});

// Límite general para el resto de /api -- incluye /api/lab/* (panel admin).
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' },
  keyGenerator: (req) => keyFor(req.ip),
  handler: onRateLimit('api'),
});
