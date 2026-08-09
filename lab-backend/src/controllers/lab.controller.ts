import { Response, Request } from 'express';
import { getDb, persist, resetDb, dbPath } from '../store/db';
import { SCENARIOS, applyScenario } from '../data/scenarios';
import { newId } from '../lib/ids';
import { emptyConnections, LabUser, Platform, UserRole, UserTier, WorkflowMode } from '../store/types';
import { getRateLimitEvents, resetRateLimitsForIp } from '../middleware/rate-limit.middleware';

export const getRateLimits = (_req: Request, res: Response): void => {
  res.json({ events: getRateLimitEvents() });
};

export const resetMyRateLimits = (req: Request, res: Response): void => {
  resetRateLimitsForIp(req.ip);
  res.json({ ok: true });
};

// GET /api/lab/scenarios
export const getScenarios = (_req: Request, res: Response): void => {
  res.json({ scenarios: SCENARIOS });
};

function credentialsResponse(user: LabUser) {
  return { id: user.id, username: user.username, password: user.password, scenario: user.scenario, role: user.role, tier: user.tier, isOwner: user.isOwner, hasCloudStorage: user.hasCloudStorage, connections: user.connections };
}

// POST /api/lab/scenarios/:key/apply { username, password? }
export const applyScenarioHandler = (req: Request, res: Response): void => {
  const { key } = req.params as { key: string };
  if (!SCENARIOS.some(s => s.key === key)) { res.status(404).json({ message: `Escenario desconocido: ${key}` }); return; }
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username) { res.status(400).json({ message: 'username requerido.' }); return; }
  try {
    const user = applyScenario(key, username, password || 'laboratorio123');
    res.status(201).json(credentialsResponse(user));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/lab/users -- lista (sin password, salvo que se pida explícito con ?showPasswords=true)
export const listUsers = (req: Request, res: Response): void => {
  const showPasswords = req.query.showPasswords === 'true';
  const users = getDb().users.map(u => showPasswords ? credentialsResponse(u) : { ...credentialsResponse(u), password: undefined });
  res.json({ total: users.length, users });
};

// POST /api/lab/users -- crear/editar un usuario mock a mano, con TODOS los
// campos pedidos: username, rol, tier, isOwner, canUseCloudStorage, modo de
// flujo, conexiones por plataforma. Upsert por username (igual que applyScenario).
export const createOrUpdateUser = (req: Request, res: Response): void => {
  const body = req.body as {
    username?: string; password?: string; role?: UserRole; tier?: UserTier;
    isOwner?: boolean; hasCloudStorage?: boolean; workflowMode?: WorkflowMode;
    connections?: Partial<Record<Platform, { status?: string; accountName?: string }>>;
  };
  if (!body.username) { res.status(400).json({ message: 'username requerido.' }); return; }
  const db = getDb();
  const uname = body.username.toLowerCase();
  let user = db.users.find(u => u.username === uname);
  if (!user) {
    user = {
      id: newId(), username: uname, password: body.password || 'laboratorio123',
      role: 'editor', tier: 'free', isOwner: false, hasCloudStorage: false,
      workflowMode: 'simple', scenario: 'custom', connections: emptyConnections(),
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
  }
  if (body.password !== undefined) user.password = body.password;
  if (body.role !== undefined) user.role = body.role;
  if (body.tier !== undefined) user.tier = body.tier;
  if (body.isOwner !== undefined) user.isOwner = body.isOwner;
  if (body.hasCloudStorage !== undefined) user.hasCloudStorage = body.hasCloudStorage;
  if (body.workflowMode !== undefined) user.workflowMode = body.workflowMode;
  if (body.connections) {
    for (const [platform, conn] of Object.entries(body.connections)) {
      if (!conn) continue;
      const p = platform as Platform;
      user.connections[p] = {
        status: (conn.status as any) ?? user.connections[p]?.status ?? 'disconnected',
        accountName: conn.accountName ?? user.connections[p]?.accountName,
        accessToken: user.connections[p]?.accessToken,
        expiresAt: user.connections[p]?.expiresAt,
      };
    }
  }
  user.scenario = 'custom';
  persist();
  res.status(201).json(credentialsResponse(user));
};

// PATCH /api/lab/users/:id -- mismos campos que arriba, pero por id.
export const updateUser = (req: Request, res: Response): void => {
  const db = getDb();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
  const body = req.body as Partial<LabUser> & { connections?: Partial<Record<Platform, { status?: string; accountName?: string }>> };
  if (body.role !== undefined) user.role = body.role;
  if (body.tier !== undefined) user.tier = body.tier;
  if (body.isOwner !== undefined) user.isOwner = body.isOwner;
  if (body.hasCloudStorage !== undefined) user.hasCloudStorage = body.hasCloudStorage;
  if (body.workflowMode !== undefined) user.workflowMode = body.workflowMode;
  if (body.password !== undefined) user.password = body.password;
  if (body.connections) {
    for (const [platform, conn] of Object.entries(body.connections)) {
      if (!conn) continue;
      const p = platform as Platform;
      user.connections[p] = { ...user.connections[p], ...conn } as any;
    }
  }
  user.scenario = 'custom';
  persist();
  res.json(credentialsResponse(user));
};

// DELETE /api/lab/users/:id
export const deleteUser = (req: Request, res: Response): void => {
  const db = getDb();
  const before = db.users.length;
  db.users = db.users.filter(u => u.id !== req.params.id);
  db.files = db.files.filter(f => f.userId !== req.params.id);
  db.platformVideos = db.platformVideos.filter(p => p.userId !== req.params.id);
  db.uploadHistory = db.uploadHistory.filter(h => h.userId !== req.params.id);
  db.publishingStatus = db.publishingStatus.filter(p => p.userId !== req.params.id);
  db.calendarConfigs = db.calendarConfigs.filter(c => c.userId !== req.params.id);
  db.publishJobs = db.publishJobs.filter(j => j.userId !== req.params.id);
  persist();
  res.json({ ok: true, deleted: before - db.users.length });
};

// POST /api/lab/reset -- vacía TODO el store del Laboratorio (usuarios,
// catálogo, historial, jobs). No toca nada fuera de lab-data/lab.json.
export const reset = (_req: Request, res: Response): void => {
  resetDb();
  res.json({ ok: true, dbPath: dbPath() });
};
