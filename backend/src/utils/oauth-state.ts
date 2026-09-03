import crypto from 'crypto';
import mongoose from 'mongoose';
import { env } from '../config/env';

const STATE_TTL_SECONDS = 10 * 60;
const STATE_VERSION = 1;

interface StatePayload {
  ver: number;
  u: string;
  o?: string;
  c?: string;
  i?: string;
  d?: string;
  v?: string;
  n: string;
  iat: number;
  exp: number;
}

export interface DecodedState {
  userId: string;
  origin: string;
  client?: string;
  installationId?: string;
  deviceName?: string;
  appVersion?: string;
}

let indexesReady: Promise<unknown> | null = null;

function nonceCollection() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB no está disponible para emitir state OAuth.');
  if (!indexesReady) {
    const collection = db.collection('oauth_state_nonces');
    indexesReady = Promise.all([
      collection.createIndex({ nonceHash: 1 }, { unique: true }),
      collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }
  return db.collection('oauth_state_nonces');
}

function hmac(body: string): Buffer {
  return crypto.createHmac('sha256', env.OAUTH_STATE_SECRET).update(body).digest();
}

function nonceHash(nonce: string): string {
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.slice(0, max);
}

export async function encodeState(
  userId: string,
  origin?: string,
  client?: string,
  device?: { installationId?: string; deviceName?: string; appVersion?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(24).toString('base64url');
  const payload: StatePayload = {
    ver: STATE_VERSION,
    u: userId,
    n: nonce,
    iat: now,
    exp: now + STATE_TTL_SECONDS,
  };
  if (origin) payload.o = safeOrigin(origin);
  if (client) payload.c = bounded(client, 16);
  if (device?.installationId) payload.i = bounded(device.installationId, 128);
  if (device?.deviceName) payload.d = bounded(device.deviceName, 128);
  if (device?.appVersion) payload.v = bounded(device.appVersion, 32);

  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = hmac(body).toString('base64url');
  const collection = nonceCollection();
  await indexesReady;
  await collection.insertOne({
    nonceHash: nonceHash(nonce),
    userId,
    createdAt: new Date(now * 1000),
    expiresAt: new Date(payload.exp * 1000),
  });
  return `${body}.${signature}`;
}

export async function decodeState(state: string): Promise<DecodedState> {
  if (state.length > 4096) throw new Error('OAuth state inválido.');
  const [body, encodedSignature, extra] = state.split('.');
  if (!body || !encodedSignature || extra !== undefined) throw new Error('OAuth state inválido.');

  let signature: Buffer;
  try {
    signature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new Error('OAuth state inválido.');
  }
  const expected = hmac(body);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    throw new Error('OAuth state inválido.');
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new Error('OAuth state inválido.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    payload.ver !== STATE_VERSION || typeof payload.u !== 'string' || !payload.u ||
    typeof payload.n !== 'string' || !payload.n || typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' || payload.iat > now + 30 || payload.exp <= now ||
    payload.exp - payload.iat !== STATE_TTL_SECONDS
  ) {
    throw new Error('OAuth state inválido o expirado.');
  }

  const collection = nonceCollection();
  await indexesReady;
  const consumed = await collection.findOneAndDelete({
    nonceHash: nonceHash(payload.n),
    userId: payload.u,
    expiresAt: { $gt: new Date() },
  });
  if (!consumed) throw new Error('OAuth state ya utilizado o desconocido.');

  return {
    userId: payload.u,
    origin: safeOrigin(payload.o),
    client: payload.c,
    installationId: payload.i,
    deviceName: payload.d,
    appVersion: payload.v,
  };
}

export function safeOrigin(origin?: string): string {
  if (!origin) return env.FRONTEND_URL;
  try {
    const parsed = new URL(origin);
    const normalized = `${parsed.protocol}//${parsed.host}`;
    if (env.ALLOWED_ORIGINS.includes(normalized)) return normalized;

    // La app instalada sirve su UI en localhost:4000 y la vista LAN usa una
    // IP privada. El state firmado impide que un tercero cambie este destino;
    // aun así se limita a loopback/RFC1918 y a http(s), nunca a un host público
    // arbitrario.
    const host = parsed.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' ||
      host.startsWith('192.168.') || host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isLocal && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) return normalized;
  } catch {
    // Usa el origen configurado y seguro.
  }
  return env.FRONTEND_URL;
}
