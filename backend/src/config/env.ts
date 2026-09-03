const isProduction = process.env.NODE_ENV === 'production';

function value(name: string, developmentFallback?: string): string {
  const configured = process.env[name]?.trim();
  if (configured) return configured;
  if (!isProduction && developmentFallback !== undefined) return developmentFallback;
  throw new Error(`Falta la variable de entorno obligatoria ${name}.`);
}

function secret(name: string, developmentFallback?: string): string {
  const configured = value(name, developmentFallback);
  if (isProduction && configured.length < 32) {
    throw new Error(`${name} debe tener al menos 32 caracteres en producción.`);
  }
  return configured;
}

function url(name: string, developmentFallback?: string, httpsInProduction = false): string {
  const configured = value(name, developmentFallback).replace(/\/$/, '');
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`${name} debe ser una URL válida.`);
  }
  if (isProduction && httpsInProduction && parsed.protocol !== 'https:') {
    throw new Error(`${name} debe usar HTTPS en producción.`);
  }
  return configured;
}

function port(): number {
  const parsed = Number(process.env.PORT || 4000);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('PORT debe ser un puerto válido.');
  }
  return parsed;
}

// Config verdaderamente opcional por plataforma (YouTube/Meta/TikTok): si
// falta, esa plataforma queda deshabilitada -- el código que la usa ya
// chequea truthiness antes de llamarla (ej. `if (configId) {...}` en
// instagram-upload.controller.ts, o el uso best-effort de YOUTUBE_API_KEY en
// youtube.service.ts). A diferencia de `value()`, NUNCA debe impedir que el
// resto del backend arranque, ni en producción -- un cliente que solo usa
// TikTok no tiene por qué configurar YouTube/Meta para poder levantar.
function optionalValue(name: string): string {
  return process.env[name]?.trim() ?? '';
}

// Igual que optionalValue, pero si SÍ hay un valor cargado exige el mismo
// mínimo de entropía que un secreto obligatorio en producción -- evita el
// caso a medio configurar (client id puesto, secret puesto pero corto).
function optionalSecret(name: string): string {
  const configured = process.env[name]?.trim() ?? '';
  if (configured && isProduction && configured.length < 32) {
    throw new Error(`${name} debe tener al menos 32 caracteres en producción (o dejarse vacío para deshabilitar esa plataforma).`);
  }
  return configured;
}

// Igual que optionalValue, pero valida formato de URL / HTTPS solo cuando
// hay un valor -- si la plataforma no está configurada, esta URL no se usa
// nunca, así que no tiene sentido exigirla ni validarla.
function optionalUrl(name: string, httpsInProduction = false): string {
  const raw = process.env[name]?.trim();
  if (!raw) return '';
  const configured = raw.replace(/\/$/, '');
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(`${name} debe ser una URL válida si se configura.`);
  }
  if (isProduction && httpsInProduction && parsed.protocol !== 'https:') {
    throw new Error(`${name} debe usar HTTPS en producción.`);
  }
  return configured;
}

const allowedOriginsRaw = value(
  'ALLOWED_ORIGINS',
  'http://localhost:5173,http://127.0.0.1:5173,https://esse-analytics.com,https://www.esse-analytics.com',
);
const allowedOrigins = allowedOriginsRaw.split(',').map(origin => origin.trim().replace(/\/$/, '')).filter(Boolean);
for (const origin of allowedOrigins) url('ALLOWED_ORIGINS entry', origin, isProduction);

// Leer toda la configuración en un único punto hace que un despliegue incompleto
// falle antes de abrir el puerto. En desarrollo se conservan valores locales
// explícitos; nunca se usan como fallback con NODE_ENV=production.
export const env = Object.freeze({
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_PRODUCTION: isProduction,
  PORT: port(),
  // Sin fallback: content-automation-dashboard/CLAUDE.md es explícito ("La
  // central no arranca sin MONGO_URI") -- ni siquiera en desarrollo debe
  // conectar en silencio contra un Mongo local no configurado a propósito.
  MONGO_URI: value('MONGO_URI'),
  JWT_SECRET: secret('JWT_SECRET', 'esse_secret_key_2024'),
  CLIENT_REGISTER_KEY: secret('CLIENT_REGISTER_KEY', 'dev-only-not-a-real-key'),
  OAUTH_STATE_SECRET: secret('OAUTH_STATE_SECRET', 'development-oauth-state-secret-change-me'),
  OWNER_USERNAME: value('OWNER_USERNAME', 'esse').toLowerCase(),
  FRONTEND_URL: url('FRONTEND_URL', 'http://localhost:5173', true),
  API_URL: url('API_URL', 'http://localhost:4000', true),
  PUBLIC_API_ORIGIN: url('PUBLIC_API_ORIGIN', 'http://localhost:4000', true),
  ALLOWED_ORIGINS: allowedOrigins,
  // Las tres plataformas son opcionales por diseño (un cliente puede usar
  // solo una) -- optionalValue/optionalSecret/optionalUrl nunca impiden que
  // arranque el resto del backend, en ningún ambiente.
  YOUTUBE_CLIENT_ID: optionalValue('YOUTUBE_CLIENT_ID'),
  YOUTUBE_CLIENT_SECRET: optionalSecret('YOUTUBE_CLIENT_SECRET'),
  YOUTUBE_REDIRECT_URI: optionalUrl('YOUTUBE_REDIRECT_URI', true),
  YOUTUBE_API_KEY: optionalValue('YOUTUBE_API_KEY'),
  YOUTUBE_CHANNEL_ID: optionalValue('YOUTUBE_CHANNEL_ID'),
  META_APP_ID: optionalValue('META_APP_ID'),
  META_APP_SECRET: optionalSecret('META_APP_SECRET'),
  META_LOGIN_CONFIG_ID: optionalValue('META_LOGIN_CONFIG_ID'),
  META_REDIRECT_URI: optionalUrl('META_REDIRECT_URI', true),
  TIKTOK_CLIENT_KEY: optionalValue('TIKTOK_CLIENT_KEY'),
  TIKTOK_CLIENT_SECRET: optionalSecret('TIKTOK_CLIENT_SECRET'),
  TIKTOK_REDIRECT_URI: optionalUrl('TIKTOK_REDIRECT_URI', true),
});

export type AppEnv = typeof env;
