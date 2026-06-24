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
      { id: user._id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: { username: user.username, role: user.role } });
  } catch (err: any) {
    await LoginLogModel.create({
      username: username ?? 'unknown',
      success: false,
      failReason: 'server_error',
      ip,
      ...ua,
    }).catch(() => {}); // no bloquear si el log mismo falla
    res.status(500).json({ message: 'Error interno.', error: err.message });
  }
};

export const me = async (req: AuthRequest, res: Response): Promise<void> => {
  res.json({ user: req.user });
};

export const getLoginLogs = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const logs = await LoginLogModel.find()
      .sort({ at: -1 })
      .limit(5)
      .lean();
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ message: 'Error al obtener logs.', error: err.message });
  }
};
