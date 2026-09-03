import crypto from 'crypto';

// Base compartida: crypto.timingSafeEqual exige buffers del mismo largo, así
// que el chequeo de longitud (que SÍ puede hacerse en tiempo variable, la
// longitud no es secreta) va antes, corto-circuitando sin comparar bytes.
export function timingSafeBufferEqual(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function timingSafeStringEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  return timingSafeBufferEqual(Buffer.from(actual), Buffer.from(expected));
}
