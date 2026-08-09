// Uploader mock de local-backend/Electron -- SOLO se llama cuando LAB_MODE es
// true (ver config.ts). Nunca toca googleapis/graph.facebook/open.tiktokapis;
// simula progreso/procesamiento y devuelve un id/url CLARAMENTE ficticios,
// mismo criterio que lab-backend/src/lib/ids.ts (mismo prefijo `lab_` para
// que un platformId de acá y uno generado en el Laboratorio se reconozcan
// igual de mock si algún día se comparan).
//
// Punto único de inyección: cada controller de subida (youtube/instagram/
// tiktok-upload.controller.ts) rama UNA vez, al principio de su lógica de
// "subir bytes de verdad", hacia esta función en vez de la llamada real --
// nunca hay un `if (LAB_MODE)` disperso en el resto del archivo (fileRepo,
// calendario, historial, backup siguen exactamente el mismo camino que en
// producción, ver config.ts::CENTRAL_API).
import { randomBytes } from 'crypto';

export type Platform = 'youtube' | 'instagram' | 'tiktok' | 'facebook';
export type MockUploadMode = 'success' | 'fail' | 'token_expired' | 'interrupted';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PREFIX: Record<Platform, string> = { youtube: 'lab_yt', instagram: 'lab_ig', tiktok: 'lab_tt', facebook: 'lab_fb' };

export function mockPlatformId(platform: Platform): string {
  return `${PREFIX[platform]}_${randomBytes(6).toString('hex')}`;
}

export function mockPlatformUrl(platform: Platform, platformId: string): string {
  return `https://laboratorio.esse-analytics.local/mock/${platform}/${platformId}`;
}

export class MockUploadError extends Error {
  code: 'NO_AUTH' | 'RECOVERABLE' | 'INTERRUPTED';
  retryable: boolean;
  constructor(message: string, code: 'NO_AUTH' | 'RECOVERABLE' | 'INTERRUPTED', retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

// Simula una publicación completa: progreso 10→90 en escalones, con el mismo
// callback (percent, phase) que ya consume setUploadProgress en los
// controllers reales, así el progreso sigue siendo visible en la UI de
// Electron sin ningún cambio ahí. `mode` es un escape hatch para probar cada
// escenario a mano (ver README) -- el body de /api/{platform}/upload puede
// mandar `labSimulate: 'fail'|'token_expired'|'interrupted'`; sin ese campo,
// el default es 'success'.
export async function simulateMockUpload(
  platform: Platform,
  mode: MockUploadMode,
  onProgress: (percent: number, phase: 'uploading' | 'processing') => void,
): Promise<{ platformId: string; platformUrl: string }> {
  for (let percent = 10; percent <= 90; percent += 10) {
    await sleep(250);
    if (mode === 'interrupted' && percent >= 30) {
      throw new MockUploadError('La subida se interrumpió (simulado: conexión perdida). Reintentá.', 'INTERRUPTED', true);
    }
    if (mode === 'token_expired' && percent >= 20) {
      throw new MockUploadError('El token de la plataforma venció durante la subida (simulado). Reconectá la cuenta.', 'NO_AUTH', false);
    }
    if (mode === 'fail' && percent >= 40) {
      throw new MockUploadError('Error recuperable simulado: la plataforma devolvió un 500. Reintentá.', 'RECOVERABLE', true);
    }
    onProgress(percent, percent < 60 ? 'uploading' : 'processing');
  }
  await sleep(250);
  const platformId = mockPlatformId(platform);
  return { platformId, platformUrl: mockPlatformUrl(platform, platformId) };
}
