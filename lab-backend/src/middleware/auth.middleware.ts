import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { UserRole, UserTier } from '../store/types';

export interface AuthRequest extends Request {
  user?: { id: string; username: string; role: UserRole; tier: UserTier; isOwner: boolean; hasCloudStorage: boolean };
}

export function signLabToken(payload: AuthRequest['user']): string {
  return jwt.sign(payload as object, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Token requerido.' });
    return;
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET) as AuthRequest['user'];
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado.' });
  }
}

export function requireOwner(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user?.isOwner) {
    res.status(403).json({ message: 'Solo el owner puede hacer esto.' });
    return;
  }
  next();
}
