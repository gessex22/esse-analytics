import { randomBytes, randomUUID } from 'crypto';
import { Platform } from '../store/types';

export function newId(): string {
  return randomUUID();
}

function randomToken(len = 10): string {
  return randomBytes(len).toString('hex');
}

// IDs y URLs de plataforma CLARAMENTE identificables como mock -- nunca se
// parecen a un id real de YouTube/Instagram/TikTok, a propósito (requisito
// explícito: "Generar IDs y URLs ficticias claramente identificables").
const PREFIX: Record<Platform, string> = { youtube: 'lab_yt', instagram: 'lab_ig', tiktok: 'lab_tt' };

export function mockPlatformId(platform: Platform): string {
  return `${PREFIX[platform]}_${randomToken(6)}`;
}

export function mockPlatformUrl(platform: Platform, platformId: string): string {
  return `https://laboratorio.esse-analytics.local/mock/${platform}/${platformId}`;
}

export function mockAccessToken(platform: Platform): string {
  return `lab_token_${platform}_${randomToken(16)}`;
}

export function mockThumbnailUrl(seed: string): string {
  return `https://laboratorio.esse-analytics.local/mock/thumb/${encodeURIComponent(seed)}`;
}
