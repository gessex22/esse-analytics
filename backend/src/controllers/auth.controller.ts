import { Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UAParser } from 'ua-parser-js';
import { UserModel } from '../models/user.model';
import { LoginLogModel } from '../models/login-log.model';
import { AuthRequest, isOwner } from '../middleware/auth.middleware';

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

// Solo el cliente instalado (local-backend) puede registrar. El local-backend
// añade este header al proxear; la web online no lo tiene → no puede registrar.
const CLIENT_REGISTER_KEY = process.env.CLIENT_REGISTER_KEY || 'esse_local_client_2024';

// ── POST /api/auth/register ───────────────────────────────────────────────────
export const register = async (req: Request, res: Response): Promise<void> => {
  const { username, password, email } = req.body as { username?: string; password?: string; email?: string };

  // El registro solo está disponible desde la aplicación instalada
  if (req.headers['x-client-key'] !== CLIENT_REGISTER_KEY) {
    res.status(403).json({ message: 'El registro solo está disponible desde la aplicación instalada.' });
    return;
  }

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
    // Cada cliente es "todopoderoso" en SU propia instancia local (configura
    // biblioteca, escaneo, etc.). El acceso a la administración central está
    // restringido aparte al owner del servicio (requireOwner).
    const user = await UserModel.create({
      username: username.toLowerCase(),
      password: hashed,
      role: 'todopoderoso',
      tier: 'free',
      ...(email ? { email } : {}),
    });

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, tier: user.tier, isOwner: isOwner(user.username) },
      JWT_SECRET,
      { expiresIn: '7d' },
    );

    res.status(201).json({
      token,
      user: { username: user.username, role: user.role, tier: user.tier, isOwner: isOwner(user.username) },
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

    if (user.status === 'deleted') {
      await LoginLogModel.create({ username: user.username, success: false, failReason: 'server_error', ip, ...ua });
      res.status(403).json({ message: 'Esta cuenta fue dada de baja.' });
      return;
    }

    await LoginLogModel.create({ username: user.username, success: true, ip, ...ua });

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, tier: user.tier, isOwner: isOwner(user.username) },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { username: user.username, role: user.role, tier: user.tier, isOwner: isOwner(user.username) },
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
    res.json({ user: { id: user._id, username: user.username, role: user.role, tier: user.tier, isOwner: isOwner(user.username) } });
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
// ?q=texto  &status=active|deleted  &limit=5  &offset=0
export const getUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const q      = (req.query.q      as string) || '';
    const status = (req.query.status as string) || 'active';   // 'active' | 'deleted'
    const limit  = Math.min(parseInt(req.query.limit  as string) || 5, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const filter: Record<string, any> = { status };
    if (q) {
      filter.$or = [
        { username: { $regex: q, $options: 'i' } },
        { email:    { $regex: q, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      UserModel.find(filter).select('-password').sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      UserModel.countDocuments(filter),
    ]);

    res.json({
      total,
      users: users.map(u => ({
        id:                u._id,
        username:          u.username,
        role:              u.role,
        tier:              u.tier,
        status:            (u as any).status ?? 'active',
        email:             u.email,
        linkedPlatforms:   (u as any).linkedPlatforms ?? [],
        youtubeChannel:    (u as any).youtubeChannel,
        youtubeChannelUrl: (u as any).youtubeChannelUrl,
        instagramAccount:  (u as any).instagramAccount,
        tiktokAccount:     (u as any).tiktokAccount,
        firstLinkedAt:     (u as any).firstLinkedAt,
        deletedAt:         (u as any).deletedAt,
        createdAt:         (u as any).createdAt,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al obtener usuarios.', error: err.message });
  }
};

// ── PATCH /api/auth/users/:id/deactivate (owner da de baja a cualquier usuario) ──
export const deactivateUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await UserModel.findByIdAndUpdate(
      req.params.id,
      { status: 'deleted', deletedAt: new Date() },
      { new: true },
    ).select('-password');
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al dar de baja.', error: err.message });
  }
};

// ── POST /api/auth/me/deactivate ──────────────────────────────────────────────
// El propio usuario marca su cuenta como dada de baja (soft delete).
export const deactivateMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await UserModel.findByIdAndUpdate(
      req.user!.id,
      { status: 'deleted', deletedAt: new Date() },
      { new: true },
    ).select('-password');
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al dar de baja la cuenta.', error: err.message });
  }
};

// ── POST /api/auth/local-reset ────────────────────────────────────────────────
// Solo accesible desde el cliente instalado (X-Client-Key). Permite resetear la
// contraseña sin conocer la actual — útil si el usuario la olvidó.
export const localResetPassword = async (req: Request, res: Response): Promise<void> => {
  if (req.headers['x-client-key'] !== CLIENT_REGISTER_KEY) {
    res.status(403).json({ message: 'Solo disponible desde la aplicación instalada.' });
    return;
  }
  const { username, newPassword } = req.body as { username?: string; newPassword?: string };
  if (!username || !newPassword) {
    res.status(400).json({ message: 'Usuario y nueva contraseña requeridos.' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' });
    return;
  }
  try {
    const user = await UserModel.findOne({ username: username.toLowerCase() });
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al resetear contraseña.', error: err.message });
  }
};

// ── POST /api/auth/local-deactivate ───────────────────────────────────────────
// Da de baja la cuenta vinculada a una instalación y REVOCA el acceso a los canales
// (borra todos sus tokens OAuth). No requiere contraseña — pensado para cuando el
// usuario la olvidó y necesita cortar el acceso. Protegido por X-Client-Key (solo
// desde la app instalada), igual que el reset de contraseña.
export const localDeactivate = async (req: Request, res: Response): Promise<void> => {
  if (req.headers['x-client-key'] !== CLIENT_REGISTER_KEY) {
    res.status(403).json({ message: 'Solo disponible desde la aplicación instalada.' });
    return;
  }
  const { username } = req.body as { username?: string };
  if (!username) {
    res.status(400).json({ message: 'Usuario requerido.' });
    return;
  }
  try {
    const user = await UserModel.findOne({ username: username.toLowerCase() });
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }

    // 1. Marcar la cuenta como dada de baja
    user.status = 'deleted';
    user.deletedAt = new Date();
    await user.save();

    // 2. Revocar acceso a los canales: borrar todos los tokens OAuth del usuario
    const db = mongoose.connection.db;
    let revoked = 0;
    if (db) {
      const r = await db.collection('oauth_tokens').deleteMany({ userId: String(user._id) });
      revoked = r.deletedCount ?? 0;
    }

    res.json({ ok: true, revokedTokens: revoked });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al dar de baja la cuenta.', error: err.message });
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
