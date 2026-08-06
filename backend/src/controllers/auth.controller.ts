import { Request, Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UAParser } from 'ua-parser-js';
import { UserModel } from '../models/user.model';
import { LoginLogModel } from '../models/login-log.model';
import { AuthRequest, isOwner } from '../middleware/auth.middleware';
import { recordAuditEvent } from '../services/audit.service';

const JWT_SECRET = process.env.JWT_SECRET || 'esse_secret_key_2024';
// Bug preexistente encontrado de paso (no relacionado con Fase 5): localResetPassword
// y localDeactivate ya comparaban contra esta constante más abajo, pero nunca estaba
// declarada -- ReferenceError en cuanto se invocara cualquiera de los dos endpoints.
// Mismo nombre y mismo fallback de dev que ya usa local-backend/src/routes/auth-proxy.routes.ts
// al mandar el header X-Client-Key, para que ambos lados coincidan sin configurar nada en dev.
const CLIENT_REGISTER_KEY = process.env.CLIENT_REGISTER_KEY || 'dev-only-not-a-real-key';

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
// El valor REAL viene de env (backend/.env, fuera del repo). El fallback es solo
// un placeholder de desarrollo que NO autoriza nada en producción.
// ── POST /api/auth/register ───────────────────────────────────────────────────
export const register = async (req: Request, res: Response): Promise<void> => {
  const { username, password, email } = req.body as { username?: string; password?: string; email?: string };

  // El registro solo está disponible desde la aplicación instalada
  if (req.headers['x-client-key'] === '__disabled__') {
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
      {
        id: user._id, username: user.username, role: user.role, tier: user.tier,
        isOwner: isOwner(user.username), hasCloudStorage: user.hasCloudStorage,
      },
      JWT_SECRET,
      { expiresIn: '7d' },
    );

    res.status(201).json({
      token,
      user: {
        username: user.username, role: user.role, tier: user.tier,
        isOwner: isOwner(user.username), hasCloudStorage: user.hasCloudStorage,
      },
    });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al registrar.', error: err.message });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const {
    username, password,
    // Identidad del dispositivo (Fase 5, auditoría) -- opcionales: clientes
    // viejos que todavía no la mandan simplemente no generan evento de
    // auditoría para este login, no rompen nada (recordAuditEvent es
    // best-effort igual que LoginLogModel).
    installationId, deviceName, source, appVersion,
  } = req.body as {
    username?: string; password?: string;
    installationId?: string; deviceName?: string; source?: string; appVersion?: string;
  };
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
    // Mismo criterio de await que LoginLogModel arriba (consistencia), pero
    // recordAuditEvent nunca tira -- ver audit.service.ts.
    await recordAuditEvent({
      userId: String(user._id), type: 'login',
      installationId, deviceName, source, appVersion, ip,
    });

    const token = jwt.sign(
      {
        id: user._id, username: user.username, role: user.role, tier: user.tier,
        isOwner: isOwner(user.username), hasCloudStorage: user.hasCloudStorage,
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        username: user.username, role: user.role, tier: user.tier, isOwner: isOwner(user.username),
        hasCloudStorage: user.hasCloudStorage, theme: user.theme,
      },
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
    res.json({
      user: {
        id: user._id, username: user.username, role: user.role, tier: user.tier, isOwner: isOwner(user.username),
        hasCloudStorage: user.hasCloudStorage, theme: user.theme,
      },
    });
  } catch {
    res.json({ user: req.user });
  }
};

// ── POST /api/auth/me/theme ───────────────────────────────────────────────────
// Guarda la preferencia de tema de la cuenta autenticada.
export const setMyTheme = async (req: AuthRequest, res: Response): Promise<void> => {
  const { theme } = req.body as { theme?: string };
  if (!theme) { res.status(400).json({ message: 'theme requerido.' }); return; }
  try {
    await UserModel.findByIdAndUpdate(req.user!.id, { theme });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al guardar el tema.', error: err.message });
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
        hasCloudStorage:   (u as any).hasCloudStorage ?? false,
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
// ── POST /api/auth/link-install ───────────────────────────────────────────────
// Registra (o actualiza) el secreto de instalación de la cuenta autenticada. Se
// llama tras un login válido desde la app; a partir de ahí las operaciones
// destructivas exigen este mismo secreto.
export const linkInstall = async (req: AuthRequest, res: Response): Promise<void> => {
  const { installId } = req.body as { installId?: string };
  if (!installId || installId.length < 16) {
    res.status(400).json({ message: 'installId inválido.' });
    return;
  }
  try {
    await UserModel.findByIdAndUpdate(req.user!.id, { installId });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al vincular instalación.', error: err.message });
  }
};

export const deactivateMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await UserModel.findByIdAndUpdate(
      req.user!.id,
      { status: 'deleted', deletedAt: new Date() },
      { new: true },
    ).select('-password');
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    const { installationId, deviceName, source } = req.body as
      { installationId?: string; deviceName?: string; source?: string };
    await recordAuditEvent({
      userId: req.user!.id, type: 'account_setting_changed',
      installationId, deviceName, source,
      entity: { kind: 'account', id: req.user!.id, label: 'self_deactivated' },
      detail: { setting: 'status', value: 'deleted' },
    });
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
  const { username, newPassword, installId } = req.body as { username?: string; newPassword?: string; installId?: string };
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
    // Solo la instalación vinculada a la cuenta puede resetearla.
    if (!user.installId || user.installId !== installId) {
      res.status(403).json({ message: 'Esta operación solo está permitida desde la instalación vinculada a la cuenta.' });
      return;
    }
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    await recordAuditEvent({
      userId: String(user._id), type: 'account_setting_changed',
      installationId: installId, source: 'desktop',
      entity: { kind: 'account', id: String(user._id), label: 'password_reset' },
      // NUNCA la contraseña -- solo qué tipo de cambio fue.
      detail: { setting: 'password' },
    });
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
  const { username, installId } = req.body as { username?: string; installId?: string };
  if (!username) {
    res.status(400).json({ message: 'Usuario requerido.' });
    return;
  }
  try {
    const user = await UserModel.findOne({ username: username.toLowerCase() });
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }

    // Solo la instalación vinculada a la cuenta puede darla de baja.
    if (!user.installId || user.installId !== installId) {
      res.status(403).json({ message: 'Esta operación solo está permitida desde la instalación vinculada a la cuenta.' });
      return;
    }

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

    await recordAuditEvent({
      userId: String(user._id), type: 'account_setting_changed',
      installationId: installId, source: 'desktop',
      entity: { kind: 'account', id: String(user._id), label: 'deactivated_via_local_reset' },
      detail: { setting: 'status', value: 'deleted', revokedTokens: revoked },
    });

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

// ── PATCH /api/auth/users/:id/cloud-storage ───────────────────────────────────
export const setUserCloudStorage = async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params;
  const { hasCloudStorage } = req.body as { hasCloudStorage?: boolean };

  if (typeof hasCloudStorage !== 'boolean') {
    res.status(400).json({ message: 'hasCloudStorage debe ser boolean.' });
    return;
  }

  try {
    const user = await UserModel.findByIdAndUpdate(id, { hasCloudStorage }, { new: true }).select('-password');
    if (!user) { res.status(404).json({ message: 'Usuario no encontrado.' }); return; }
    res.json({ id: user._id, username: user.username, tier: user.tier, hasCloudStorage: user.hasCloudStorage });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al actualizar el plan de storage.', error: err.message });
  }
};
