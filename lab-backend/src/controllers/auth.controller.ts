import { Response, Request } from 'express';
import { getDb, persist } from '../store/db';
import { AuthRequest, signLabToken } from '../middleware/auth.middleware';
import { newId } from '../lib/ids';
import { emptyConnections } from '../store/types';

function publicUser(u: ReturnType<typeof findByUsername>) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role, tier: u.tier, isOwner: u.isOwner,
    hasCloudStorage: u.hasCloudStorage, theme: u.theme, workflowMode: u.workflowMode,
    scenario: u.scenario, connections: u.connections,
  };
}

function findByUsername(username: string) {
  return getDb().users.find(u => u.username === username.toLowerCase());
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
// Mismo contrato que backend/src/controllers/auth.controller.ts::register --
// crea un usuario "todopoderoso"/free (regla real: cada cliente instalado es
// dueño de SU instancia). Sirve para probar el flujo de alta desde cero,
// aunque en la práctica conviene aplicar un escenario predefinido (ver
// lab.controller.ts) para tener datos ya sembrados.
export const register = (req: Request, res: Response): void => {
  const { username, password, email } = req.body as { username?: string; password?: string; email?: string };
  if (!username || !password) { res.status(400).json({ message: 'Usuario y contraseña requeridos.' }); return; }
  if (password.length < 6) { res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' }); return; }

  const db = getDb();
  const uname = username.toLowerCase();
  if (db.users.some(u => u.username === uname)) {
    res.status(409).json({ message: 'Ese nombre de usuario ya está en uso.' });
    return;
  }

  const user = {
    id: newId(), username: uname, password, role: 'todopoderoso' as const, tier: 'free' as const,
    isOwner: false, hasCloudStorage: false, workflowMode: 'simple' as const, scenario: 'custom',
    connections: emptyConnections(), createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  persist();

  const token = signLabToken({ id: user.id, username: user.username, role: user.role, tier: user.tier, isOwner: user.isOwner, hasCloudStorage: user.hasCloudStorage });
  res.status(201).json({ token, user: publicUser(user) });
  void email;
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────
export const login = (req: Request, res: Response): void => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) { res.status(400).json({ message: 'Usuario y contraseña requeridos.' }); return; }

  const user = findByUsername(username);
  if (!user || user.password !== password) {
    res.status(401).json({ message: 'Credenciales incorrectas.' });
    return;
  }
  if (user.status === 'deleted') {
    res.status(403).json({ message: 'Esta cuenta fue dada de baja.' });
    return;
  }

  const token = signLabToken({ id: user.id, username: user.username, role: user.role, tier: user.tier, isOwner: user.isOwner, hasCloudStorage: user.hasCloudStorage });
  res.json({ token, user: publicUser(user) });
};

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
export const me = (req: AuthRequest, res: Response): void => {
  const user = getDb().users.find(u => u.id === req.user!.id);
  if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
  res.json({ user: publicUser(user) });
};

// ── POST /api/auth/me/theme ───────────────────────────────────────────────────
export const setMyTheme = (req: AuthRequest, res: Response): void => {
  const { theme } = req.body as { theme?: string };
  if (!theme) { res.status(400).json({ message: 'theme requerido.' }); return; }
  const user = getDb().users.find(u => u.id === req.user!.id);
  if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
  user.theme = theme;
  persist();
  res.json({ ok: true });
};

// ── POST /api/auth/link-install ───────────────────────────────────────────────
export const linkInstall = (req: AuthRequest, res: Response): void => {
  const { installId } = req.body as { installId?: string };
  if (!installId || installId.length < 6) { res.status(400).json({ message: 'installId inválido.' }); return; }
  const user = getDb().users.find(u => u.id === req.user!.id);
  if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
  user.installId = installId;
  persist();
  res.json({ ok: true });
};

// ── GET /api/auth/users (owner) ───────────────────────────────────────────────
export const getUsers = (_req: AuthRequest, res: Response): void => {
  const users = getDb().users.filter(u => u.status !== 'deleted');
  res.json({ total: users.length, users: users.map(publicUser) });
};

// ── PATCH /api/auth/users/:id/tier ────────────────────────────────────────────
export const setUserTier = (req: AuthRequest, res: Response): void => {
  const { tier } = req.body as { tier?: string };
  if (tier !== 'free' && tier !== 'premium') { res.status(400).json({ message: 'tier debe ser "free" o "premium".' }); return; }
  const user = getDb().users.find(u => u.id === req.params.id);
  if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
  user.tier = tier;
  persist();
  res.json({ id: user.id, username: user.username, role: user.role, tier: user.tier });
};

// ── PATCH /api/auth/users/:id/cloud-storage ───────────────────────────────────
export const setUserCloudStorage = (req: AuthRequest, res: Response): void => {
  const { hasCloudStorage } = req.body as { hasCloudStorage?: boolean };
  if (typeof hasCloudStorage !== 'boolean') { res.status(400).json({ message: 'hasCloudStorage debe ser boolean.' }); return; }
  const user = getDb().users.find(u => u.id === req.params.id);
  if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
  user.hasCloudStorage = hasCloudStorage;
  persist();
  res.json({ id: user.id, username: user.username, tier: user.tier, hasCloudStorage: user.hasCloudStorage });
};

// ── PATCH /api/auth/users/:id/deactivate ──────────────────────────────────────
export const deactivateUser = (req: AuthRequest, res: Response): void => {
  const user = getDb().users.find(u => u.id === req.params.id);
  if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
  user.status = 'deleted';
  persist();
  res.json({ ok: true });
};

// ── POST /api/auth/me/deactivate ──────────────────────────────────────────────
export const deactivateMe = (req: AuthRequest, res: Response): void => {
  const user = getDb().users.find(u => u.id === req.user!.id);
  if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
  user.status = 'deleted';
  persist();
  res.json({ ok: true });
};
