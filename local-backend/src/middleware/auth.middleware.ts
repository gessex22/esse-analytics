import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { fetchInstallationRole } from '../services/installation-role.service';

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

// Gate duro server-side (docs/primary-install-corrected-plan-2026-08-14.md,
// Fase E) para las rutas que configuran/escanean la carpeta de videos --
// una secundaria no debe poder convertirse en un segundo catálogo físico
// completo. Va DESPUÉS de verifyToken (necesita req.headers.authorization
// ya validado). Si la central no responde (offline/error de red), deja
// pasar en vez de bloquear -- este gate es defensa en profundidad sobre el
// gate real del lado cliente (que no llama a estas rutas si ya sabe que es
// secundaria); no tiene sentido tumbar al usuario legítimo por un problema
// de conectividad ajeno a si es o no la primaria.
export async function requirePrimaryDevice(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization || '';
  const status = await fetchInstallationRole(authHeader);
  if (status && !status.canManageFolder) {
    res.status(403).json({
      error: 'PRIMARY_DEVICE_REQUIRED',
      message: 'Esta PC no es la principal de la cuenta. Solo la PC principal puede configurar o escanear la carpeta de videos.',
    });
    return;
  }
  next();
}
