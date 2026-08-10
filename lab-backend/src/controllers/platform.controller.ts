import { Response } from 'express';
import { getDb, persist } from '../store/db';
import { AuthRequest } from '../middleware/auth.middleware';
import { Platform } from '../store/types';
import { mockAccessToken } from '../lib/ids';
import { createJob, runSimulation, getJob, listJobs, cancelJob, retryJob, SimulateMode } from './publish-jobs.service';

function getUser(req: AuthRequest) {
  return getDb().users.find(u => u.id === req.user!.id);
}

function connectUser(user: NonNullable<ReturnType<typeof getUser>>, platform: Platform, accountName?: string) {
  user.connections[platform] = {
    status: 'connected',
    accountName: accountName || `@lab.${platform}`,
    accessToken: mockAccessToken(platform),
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
  persist();
  return user.connections[platform];
}

function accountInfo(platform: Platform, accountName: string | null) {
  const handle = (accountName || `@lab.${platform}`).replace(/^@/, '');
  const avatarUrl = '';

  if (platform === 'youtube') {
    return { name: accountName || 'Canal Laboratorio', customUrl: `@${handle}`, avatarUrl };
  }
  if (platform === 'instagram') {
    return { name: accountName || `@${handle}`, username: handle, avatarUrl };
  }
  return {
    nickname: accountName || `@${handle}`,
    username: handle,
    avatarUrl,
    privacyOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    maxVideoDurationSec: 600,
  };
}

// GET /api/{youtube,instagram,tiktok}/{channel-info,account-info,creator-info}
export function connectionInfo(platform: Platform) {
  return (req: AuthRequest, res: Response): void => {
    const user = getUser(req);
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    const conn = user.connections[platform];
    if (conn.status !== 'connected') {
      res.status(401).json({ error: 'NO_AUTH', message: 'Conectá (o reconectá) la cuenta de esta plataforma primero.' });
      return;
    }
    res.json(accountInfo(platform, conn.accountName ?? null));
  };
}

// GET /api/{platform}/auth/status -- mismo contrato que la central. Una
// conexión vencida debe tratarse como desconectada: mostrarla como conectada
// dejaba a la UI ofrecer publicaciones que el uploader luego rechazaba.
export function authStatus(platform: Platform) {
  return (req: AuthRequest, res: Response): void => {
    const user = getUser(req);
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    const conn = user.connections[platform];
    if (conn.status === 'connected') { res.json({ connected: true }); return; }
    if (conn.status === 'disconnected') { res.json({ connected: false }); return; }
    res.status(401).json({ error: 'NO_AUTH', message: 'Conectá (o reconectá) la cuenta de esta plataforma primero.' });
  };
}

// GET /api/{platform}/auth/url -- mantiene el contrato OAuth de los clientes.
// El Laboratorio conecta la cuenta simulada durante esta petición autenticada y
// devuelve una vuelta a la app con el mismo query param que usaría el callback
// OAuth real. No se abre ningún proveedor ni se entrega un token real.
export function getAuthUrl(platform: Platform) {
  return (req: AuthRequest, res: Response): void => {
    const user = getUser(req);
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }

    const origin = typeof req.query.origin === 'string' ? req.query.origin : '';
    try {
      const callback = new URL(origin);
      if (!['http:', 'https:'].includes(callback.protocol)) throw new Error('invalid protocol');
      connectUser(user, platform);
      callback.searchParams.set(`${platform}_auth`, 'success');
      res.json({ url: callback.toString() });
    } catch {
      res.status(400).json({ message: 'origin válido requerido para completar la conexión simulada.' });
    }
  };
}

// GET /api/{youtube,instagram,tiktok}/token -- mismo código de error (NO_AUTH)
// que ya usan local-backend/backend para "conectá/reconectá la cuenta".
export function getToken(platform: Platform) {
  return (req: AuthRequest, res: Response): void => {
    const user = getUser(req);
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    const conn = user.connections[platform];
    if (conn.status !== 'connected') {
      res.status(401).json({ error: 'NO_AUTH', message: 'Conectá (o reconectá) la cuenta de esta plataforma primero.' });
      return;
    }
    res.json({ access_token: conn.accessToken ?? mockAccessToken(platform), expires_in: 3600 });
  };
}

// DELETE /api/{youtube,instagram,tiktok}/auth -- desconecta (revoke).
export function disconnect(platform: Platform) {
  return (req: AuthRequest, res: Response): void => {
    const user = getUser(req);
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    user.connections[platform] = { status: 'disconnected' };
    persist();
    res.json({ ok: true });
  };
}

// POST /api/{youtube,instagram,tiktok}/auth/connect -- NO existe en la central
// real (ahí es un handshake OAuth completo); es la forma que tiene el
// Laboratorio de simular "conectar la cuenta" sin ningún proveedor real detrás.
export function connect(platform: Platform) {
  return (req: AuthRequest, res: Response): void => {
    const user = getUser(req);
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    const { accountName } = req.body as { accountName?: string };
    res.json({ ok: true, connection: connectUser(user, platform, accountName) });
  };
}

// POST /api/{youtube,instagram,tiktok}/upload -- uploader mock del lado
// servidor (ver publish-jobs.service.ts). body: { fileName, title?, mode? }.
// mode por defecto 'success'; los otros valores existen para poder forzar
// cada escenario de la validación pedida sin tener que aplicar un escenario
// de usuario distinto cada vez.
export function startUpload(platform: Platform) {
  return (req: AuthRequest, res: Response): void => {
    const user = getUser(req);
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    if (user.connections[platform].status !== 'connected') {
      res.status(401).json({ error: 'NO_AUTH', message: 'Conectá (o reconectá) la cuenta de esta plataforma primero.' });
      return;
    }
    const { fileName, fileId, mode } = req.body as { fileName?: string; fileId?: string; mode?: SimulateMode };
    if (!fileName) { res.status(400).json({ message: 'fileName requerido.' }); return; }

    const job = createJob(user.id, platform, fileName, fileId ?? null);
    void runSimulation(job.id, mode ?? 'success');
    res.status(202).json({ jobId: job.id, status: job.status, progress: job.progress });
  };
}

// GET /api/lab/publish-jobs/:id
export function getJobStatus(req: AuthRequest, res: Response): void {
  const job = getJob(req.params.id as string);
  if (!job) { res.status(404).json({ message: 'Job no encontrado.' }); return; }
  res.json(job);
}

// GET /api/lab/publish-jobs?userId=
export function listJobsHandler(req: AuthRequest, res: Response): void {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : req.user?.id;
  res.json({ items: listJobs(userId) });
}

// POST /api/lab/publish-jobs/:id/cancel
export function cancelJobHandler(req: AuthRequest, res: Response): void {
  const job = cancelJob(req.params.id as string);
  if (!job) { res.status(404).json({ message: 'Job no encontrado.' }); return; }
  res.json(job);
}

// POST /api/lab/publish-jobs/:id/retry
export function retryJobHandler(req: AuthRequest, res: Response): void {
  const job = retryJob(req.params.id as string);
  if (!job) { res.status(409).json({ message: 'Este job no admite reintento.' }); return; }
  res.json(job);
}
