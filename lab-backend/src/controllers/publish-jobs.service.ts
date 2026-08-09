// Simulación de una publicación (upload) en el Laboratorio -- corre 100% en
// memoria/proceso, nunca toca googleapis/graph.facebook/open.tiktokapis. Es el
// "uploader mock" del lado servidor: útil para local-backend en modo
// Laboratorio (le alcanza con pedir /api/:platform/upload y hacer polling, sin
// reimplementar la simulación client-side) y para el panel admin. iOS/Android
// pueden usar este mismo endpoint o simular 100% client-side y solo reportar
// el resultado final a /api/sync/history -- ver README.md, sección Fase 2/3.
import { getDb, persist } from '../store/db';
import { newId, mockPlatformId, mockPlatformUrl } from '../lib/ids';
import { sleep } from '../lib/sleep';
import { applyPlatformPublish } from './publish.service';
import { LabPublishJob, Platform } from '../store/types';

export type SimulateMode = 'success' | 'fail' | 'slow' | 'interrupted' | 'token_expired';

function touch(job: LabPublishJob, fields: Partial<LabPublishJob>): void {
  Object.assign(job, fields, { updatedAt: new Date().toISOString() });
  persist();
}

export function createJob(userId: string, platform: Platform, fileName: string, fileId: string | null): LabPublishJob {
  const db = getDb();
  const job: LabPublishJob = {
    id: newId(), userId, platform, fileId, fileName,
    status: 'uploading', progress: 0, retryable: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  db.publishJobs.push(job);
  persist();
  return job;
}

export function getJob(id: string): LabPublishJob | undefined {
  return getDb().publishJobs.find(j => j.id === id);
}

export function listJobs(userId?: string): LabPublishJob[] {
  const jobs = getDb().publishJobs;
  return userId ? jobs.filter(j => j.userId === userId) : jobs;
}

export function cancelJob(id: string): LabPublishJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  if (job.status === 'uploading' || job.status === 'processing') {
    touch(job, { status: 'canceled', message: 'Cancelado por el usuario.', retryable: false });
  }
  return job;
}

// Reintento: solo tiene sentido sobre un job marcado retryable (failed/interrupted).
// Relanza la simulación en modo 'success' -- el punto de un reintento en el
// Laboratorio es poder demostrar la recuperación, no repetir el mismo fallo.
export function retryJob(id: string): LabPublishJob | undefined {
  const job = getJob(id);
  if (!job || !job.retryable) return undefined;
  touch(job, { status: 'uploading', progress: 0, message: undefined, retryable: false });
  void runSimulation(job.id, 'success');
  return job;
}

const STEP_MS: Record<SimulateMode, number> = { success: 350, fail: 350, slow: 1500, interrupted: 400, token_expired: 300 };

export async function runSimulation(jobId: string, mode: SimulateMode): Promise<void> {
  const stepMs = STEP_MS[mode];

  for (let progress = 10; progress <= 90; progress += 10) {
    await sleep(stepMs);
    const job = getJob(jobId);
    if (!job || job.status === 'canceled') return;

    if (mode === 'interrupted' && progress >= 30) {
      touch(job, { status: 'interrupted', progress, retryable: true, message: 'La subida se interrumpió (simulado: conexión perdida). Pendiente de reintento.' });
      return;
    }
    if (mode === 'token_expired' && progress >= 20) {
      const db = getDb();
      const user = db.users.find(u => u.id === job.userId);
      if (user) user.connections[job.platform].status = 'expired';
      touch(job, { status: 'failed', progress, retryable: false, message: 'El token de la plataforma venció durante la subida (simulado). Reconectá la cuenta.' });
      return;
    }
    if (mode === 'fail' && progress >= 40) {
      touch(job, { status: 'failed', progress, retryable: true, message: 'Error recuperable simulado: la plataforma devolvió un 500. Reintentá.' });
      return;
    }
    touch(job, { status: progress < 90 ? 'uploading' : 'processing', progress });
  }

  const job = getJob(jobId);
  if (!job || job.status === 'canceled') return;
  await sleep(stepMs);
  const platformId = mockPlatformId(job.platform);
  const resultUrl = mockPlatformUrl(job.platform, platformId);
  touch(job, { status: 'success', progress: 100, resultPlatformId: platformId, resultUrl, retryable: false });
  applyPlatformPublish(job.userId, { platform: job.platform, platformId, platformUrl: resultUrl, fileName: job.fileName, title: job.fileName });
  const db = getDb();
  db.uploadHistory.push({
    id: newId(), userId: job.userId, platform: job.platform, platformId, platformUrl: resultUrl,
    fileName: job.fileName, title: job.fileName, deviceId: 'lab-mock-upload', source: 'lab',
    operationId: job.id, publishedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  });
  persist();
}
