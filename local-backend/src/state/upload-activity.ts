// Registro en memoria del progreso de subidas en curso (YouTube/Instagram/TikTok).
// Mismo patrón que `progress` en plugins.ts (usado por /api/gems): un job por
// key, sin persistencia — si el proceso se reinicia a mitad de una subida, la
// subida en sí también se corta, así que no hace falta sobrevivir un restart.
export type UploadPlatform = 'youtube' | 'instagram' | 'tiktok';
export type UploadPhase    = 'uploading' | 'processing' | 'error';

export interface UploadProgress {
  platform:  UploadPlatform;
  title:     string;
  phase:     UploadPhase;
  percent?:  number; // 0-100, ausente = indeterminado
  message?:  string; // detalle del error, solo cuando phase === 'error'
  updatedAt: string;
}

const jobs: Record<string, UploadProgress> = {};

export function setUploadProgress(jobId: string, data: Omit<UploadProgress, 'updatedAt'>): void {
  jobs[jobId] = { ...data, updatedAt: new Date().toISOString() };
}

export function clearUploadProgress(jobId: string): void {
  delete jobs[jobId];
}

// Deja el error visible un rato (varios ciclos de poll del frontend, ~1.5s c/u)
// antes de limpiarlo — si se borrara al toque, /api/upload-status podría nunca
// devolverlo y el frontend jamás se enteraría de que falló en vez de terminar bien.
export function setUploadError(jobId: string, data: Omit<UploadProgress, 'updatedAt' | 'phase'>): void {
  jobs[jobId] = { ...data, phase: 'error', updatedAt: new Date().toISOString() };
  setTimeout(() => clearUploadProgress(jobId), 10000);
}

export function getAllUploadProgress(): UploadProgress[] {
  return Object.values(jobs);
}
