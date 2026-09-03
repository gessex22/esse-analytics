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
  MONGO_URI: value('MONGO_URI', 'mongodb://localhost:27017/renders_manager'),
  JWT_SECRET: secret('JWT_SECRET', 'esse_secret_key_2024'),
  CLIENT_REGISTER_KEY: secret('CLIENT_REGISTER_KEY', 'dev-only-not-a-real-key'),
  OAUTH_STATE_SECRET: secret('OAUTH_STATE_SECRET', 'development-oauth-state-secret-change-me'),
  OWNER_USERNAME: value('OWNER_USERNAME', 'esse').toLowerCase(),
  FRONTEND_URL: url('FRONTEND_URL', 'http://localhost:5173', true),
  API_URL: url('API_URL', 'http://localhost:4000', true),
  PUBLIC_API_ORIGIN: url('PUBLIC_API_ORIGIN', 'http://localhost:4000', true),
  ALLOWED_ORIGINS: allowedOrigins,
  YOUTUBE_CLIENT_ID: value('YOUTUBE_CLIENT_ID', ''),
  YOUTUBE_CLIENT_SECRET: secret('YOUTUBE_CLIENT_SECRET', 'development-youtube-client-secret-placeholder'),
  YOUTUBE_REDIRECT_URI: url('YOUTUBE_REDIRECT_URI', 'http://localhost:4000/api/youtube/auth/callback', true),
  YOUTUBE_API_KEY: value('YOUTUBE_API_KEY', ''),
  YOUTUBE_CHANNEL_ID: value('YOUTUBE_CHANNEL_ID', ''),
  META_APP_ID: value('META_APP_ID', ''),
  META_APP_SECRET: secret('META_APP_SECRET', 'development-meta-app-secret-placeholder'),
  META_LOGIN_CONFIG_ID: value('META_LOGIN_CONFIG_ID', ''),
  META_REDIRECT_URI: url('META_REDIRECT_URI', 'http://localhost:4000/api/instagram/auth/callback', true),
  TIKTOK_CLIENT_KEY: value('TIKTOK_CLIENT_KEY', ''),
  TIKTOK_CLIENT_SECRET: secret('TIKTOK_CLIENT_SECRET', 'development-tiktok-client-secret-placeholder'),
  TIKTOK_REDIRECT_URI: url('TIKTOK_REDIRECT_URI', 'http://localhost:4000/api/tiktok/auth/callback', true),
});

export type AppEnv = typeof env;
