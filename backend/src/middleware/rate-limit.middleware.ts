import rateLimit from 'express-rate-limit';

// Máximo 10 intentos de login por IP en 15 minutos
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' },
  skipSuccessfulRequests: true, // los logins exitosos no consumen el límite
});

// Límite general para todas las rutas de la API
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' },
});
