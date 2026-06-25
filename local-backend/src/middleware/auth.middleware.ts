import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'esse_secret_key_2024';

export interface AuthRequest extends Request {
  user?: { id: string; username: string; role: string; tier: string };
}

export function verifyToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Token requerido.' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as any;
    req.user = { id: payload.id, username: payload.username, role: payload.role, tier: payload.tier };
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado.' });
  }
}
