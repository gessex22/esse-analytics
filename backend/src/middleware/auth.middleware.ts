import { Request, Response, NextFunction } from 'express';
import { UserRole, UserTier } from '../models/user.model';
import { UserModel } from '../models/user.model';
import { env } from '../config/env';
import { decodeSignedAuthToken } from '../services/auth-token.service';

// Dueño del SERVICIO (no de una instancia local). Solo este usuario administra
// clientes y ve los logs en la central. Cualquier cliente registrado es
// "todopoderoso" en SU instancia, pero no es el owner del servicio.
export const OWNER_USERNAME = env.OWNER_USERNAME;

export function isOwner(username?: string): boolean {
  return !!username && username.toLowerCase() === OWNER_USERNAME;
}

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: UserRole;
    tier: UserTier;
    hasCloudStorage: boolean;
    authVersion: number;
  };
}

// Extraído para poder reverificar el mismo JWT fuera del ciclo request/response
// de Express -- ver remote-library-storage.service.ts, donde @tus/server
// envuelve el request original y no garantiza que `req.user` sobreviva.
export async function decodeAuthToken(token: string): Promise<AuthRequest['user'] | null> {
  const claims = decodeSignedAuthToken(token);
  if (!claims) return null;

  const user = await UserModel.findById(claims.id)
    .select('username role tier status hasCloudStorage authVersion')
    .lean();
  // Registros legacy pueden no tener `status`; históricamente eso significa
  // activo. Solo `deleted` es terminal y debe cortar acceso.
  if (!user || user.status === 'deleted') return null;

  const currentAuthVersion = user.authVersion ?? 0;
  // Tokens legacy equivalen a la versión inicial 0. En cuanto se cambia una
  // contraseña, plan, rol o estado, el incremento los invalida.
  if ((claims.authVersion ?? 0) !== currentAuthVersion) return null;

  return {
    id: String(user._id),
    username: user.username,
    role: user.role,
    tier: user.tier,
    hasCloudStorage: user.hasCloudStorage ?? false,
    authVersion: currentAuthVersion,
  };
}

export async function verifyToken(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Token requerido.' });
    return;
  }
  const user = await decodeAuthToken(header.slice(7));
  if (!user) {
    res.status(401).json({ message: 'Token inválido o expirado.' });
    return;
  }
  req.user = user;
  next();
}

// Igual que verifyToken, pero también acepta el token por ?token= en la query string.
// Necesario para <video src="...">/<a download> — el navegador no manda headers
// custom en esos requests, solo la URL.
export async function verifyTokenFromHeaderOrQuery(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
  if (!token) {
    res.status(401).json({ message: 'Token requerido.' });
    return;
  }
  const user = await decodeAuthToken(token);
  if (!user) {
    res.status(401).json({ message: 'Token inválido o expirado.' });
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ message: 'No tienes permisos para esta acción.' });
      return;
    }
    next();
  };
}

// Solo el dueño del servicio (administración central de clientes).
export function requireOwner(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!isOwner(req.user?.username)) {
    res.status(403).json({ message: 'Solo el administrador del servicio puede hacer esto.' });
    return;
  }
  next();
}

// Requiere plan premium. El owner del servicio siempre pasa.
export function requirePremium(req: AuthRequest, res: Response, next: NextFunction): void {
  if (isOwner(req.user?.username) || req.user?.tier === 'premium') {
    next();
    return;
  }
  res.status(403).json({ message: 'Esta función requiere plan Premium.' });
}

// Storage real (bytes de video) es un plan APARTE de tier==='premium' --
// cuesta plata, a diferencia del mirror de metadata gratis de backup-sync.
// El owner siempre pasa, igual que requirePremium.
export function requireCloudStorage(req: AuthRequest, res: Response, next: NextFunction): void {
  if (isOwner(req.user?.username) || (req.user?.tier === 'premium' && req.user?.hasCloudStorage)) {
    next();
    return;
  }
  res.status(403).json({ message: 'Esta función requiere el plan de almacenamiento en la nube.' });
}
