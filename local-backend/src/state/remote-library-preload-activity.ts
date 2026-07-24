// Registro en memoria de la precarga automática a Biblioteca remota (mismo
// patrón que upload-activity.ts) -- alimenta /api/upload-status junto con las
// subidas de YouTube/Instagram/TikTok, para que la campanita del frontend
// (useNotificationCenter) también avise "Guardando en la nube: X" sin tener
// que agregar un mecanismo de notificación nuevo.
export type PreloadPhase = 'uploading' | 'error';

export interface PreloadActivity {
  title: string;
  phase: PreloadPhase;
  message?: string;
  updatedAt: string;
}

let job: PreloadActivity | null = null;

export function setPreloadActivity(data: Omit<PreloadActivity, 'updatedAt'>): void {
  job = { ...data, updatedAt: new Date().toISOString() };
}

export function clearPreloadActivity(): void {
  job = null;
}

export function setPreloadError(title: string, message: string): void {
  job = { title, phase: 'error', message, updatedAt: new Date().toISOString() };
  setTimeout(() => { if (job?.title === title && job.phase === 'error') job = null; }, 10000);
}

export function getPreloadActivity(): PreloadActivity | null {
  return job;
}
