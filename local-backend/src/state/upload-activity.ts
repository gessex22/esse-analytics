// Registro en memoria del progreso de subidas en curso (YouTube/Instagram/TikTok).
// Mismo patrón que `progress` en plugins.ts (usado por /api/gems): un job por
// key, sin persistencia — si el proceso se reinicia a mitad de una subida, la
// subida en sí también se corta, así que no hace falta sobrevivir un restart.
export type UploadPlatform = 'youtube' | 'instagram' | 'tiktok';
export type UploadPhase    = 'uploading' | 'processing';

export interface UploadProgress {
  platform:  UploadPlatform;
  title:     string;
  phase:     UploadPhase;
  percent?:  number; // 0-100, ausente = indeterminado
  updatedAt: string;
}

const jobs: Record<string, UploadProgress> = {};

export function setUploadProgress(jobId: string, data: Omit<UploadProgress, 'updatedAt'>): void {
  jobs[jobId] = { ...data, updatedAt: new Date().toISOString() };
}

export function clearUploadProgress(jobId: string): void {
  delete jobs[jobId];
}

export function getAllUploadProgress(): UploadProgress[] {
  return Object.values(jobs);
}
