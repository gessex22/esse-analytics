import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UAParser } from 'ua-parser-js';
import { UserModel } from '../models/user.model';
import { LoginLogModel } from '../models/login-log.model';
import { AuthRequest } from '../middleware/auth.middleware';

const JWT_SECRET = process.env.JWT_SECRET || 'esse_secret_key_2024';

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function parseUA(req: Request) {
  const ua = req.headers['user-agent'] || '';
  const parser = new UAParser(ua);
  const result = parser.getResult();
  const browser = result.browser.name
    ? `${result.browser.name} ${result.browser.major ?? ''}`.trim()
    : 'unknown';
  const os = result.os.name
    ? `${result.os.name} ${result.os.version ?? ''}`.trim()
    : 'unknown';
  const device = result.device.type ?? 'desktop';
  return { browser, os, device, userAgent: ua };
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
export const register = async (req: Request, res: Response): Promise<void> => {
  const { username, password, email } = req.body as { username?: string; password?: string; email?: string };

  if (!username || !password) {
    res.status(400).json({ message: 'Usuario y contraseña requeridos.' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' });
    return;
  }

  try {
    const exists = await UserModel.findOne({ username: username.toLowerCase() });
    if (exists) {
      res.status(409).json({ message: 'Ese nombre de usuario ya está en uso.' });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await UserModel.create({
      username: username.toLowerCase(),
      password: hashed,
      role: 'editor',
      tier: 'free',
      ...(email ? { email } : {}),
    });

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, tier: user.tier },
      JWT_SECRET,
      { expiresIn: '7d' },
    );

    res.status(201).json({
      token,
      user: { username: user.username, role: user.role, tier: user.tier },
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al registrar.', error: err.message });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body as { username?: string; password?: string };
  const ip = getClientIp(req);
  const ua = parseUA(req);

  if (!username || !password) {
    res.status(400).json({ message: 'Usuario y contraseña requeridos.' });
    return;
  }

  try {
    const user = await UserModel.findOne({ username: username.toLowerCase() });

    if (!user) {
      await LoginLogModel.create({ username, success: false, failReason: 'user_not_found', ip, ...ua });
      res.status(401).json({ message: 'Credenciales incorrectas.' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      await LoginLogModel.create({ username, success: false, failReason: 'wrong_password', ip, ...ua });
      res.status(401).json({ message: 'Credenciales incorrectas.' });
      return;
    }

    await LoginLogModel.create({ username: user.username, success: true, ip, ...ua });

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, tier: user.tier },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { username: user.username, role: user.role, tier: user.tier },
    });
  } catch (err: any) {
    await LoginLogModel.create({
      username: username ?? 'unknown',
      success: false,
      failReason: 'server_error',
      ip,
      ...ua,
    }).catch(() => {});
    res.status(500).json({ message: 'Error interno.', error: err.message });
  }
};

// Siempre lee de DB para tener tier actualizado (no depende del JWT cacheado)
export const me = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await UserModel.findById(req.user!.id).select('-password').lean();
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    res.json({ user: { id: user._id, username: user.username, role: user.role, tier: user.tier } });
  } catch {
    res.json({ user: req.user });
  }
};

export const getLoginLogs = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const logs = await LoginLogModel.find().sort({ at: -1 }).limit(5).lean();
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ message: 'Error al obtener logs.', error: err.message });
  }
};

export const clearLoginLogs = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    await LoginLogModel.deleteMany({});
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al limpiar logs.', error: err.message });
  }
};

// ── GET /api/auth/users ───────────────────────────────────────────────────────
export const getUsers = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await UserModel.find().select('-password').sort({ createdAt: -1 }).lean();
    res.json(users.map(u => ({
      id: u._id,
      username: u.username,
      role: u.role,
      tier: u.tier,
      email: u.email,
      youtubeChannel: u.youtubeChannel,
      youtubeChannelUrl: u.youtubeChannelUrl,
      createdAt: (u as any).createdAt,
    })));
  } catch (err: any) {
    res.status(500).json({ message: 'Error al obtener usuarios.', error: err.message });
  }
};

// ── PATCH /api/auth/users/:id/tier ────────────────────────────────────────────
export const setUserTier = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const { tier } = req.body as { tier?: string };

  if (tier !== 'free' && tier !== 'premium') {
    res.status(400).json({ message: 'tier debe ser "free" o "premium".' });
    return;
  }

  try {
    const user = await UserModel.findByIdAndUpdate(id, { tier }, { new: true }).select('-password');
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    res.json({ id: user._id, username: user.username, role: user.role, tier: user.tier });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al actualizar tier.', error: err.message });
  }
};
