import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { fetchInstallationRole } from '../services/installation-role.service';
import { configRepo } from '../db/config.repo';

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

// Hardening para "Biblioteca LAN" (docs/lan-library-auto-switch-design-2026-08-16.md,
// sección 1.4/Fase 0) -- verifyToken por sí solo NO compara con el dueño de
// ESTA instalación: cualquier cuenta con un JWT válido (el mismo JWT_SECRET
// es compartido entre local-backend y la central, ver config.ts) que llegue
// a la LAN correcta veía el catálogo completo de una PC ajena. Antes esto
// requería tipear la IP a mano (fricción/señal de intención); con
// auto-descubrimiento la fricción baja a cero, así que hace falta el
// chequeo real acá, no solo del lado cliente.
// Va DESPUÉS de verifyToken (necesita req.user ya poblado). Sin owner
// configurado todavía (bootstrap, cuenta nueva sin loguear nunca del lado
// local-admin) deja pasar -- no hay nada que proteger todavía, y bloquear
// acá rompería el primer uso legítimo de la propia PC.
export function requireOwnerOrNoOwnerSet(req: AuthRequest, res: Response, next: NextFunction): void {
  const owner = configRepo.getOwner();
  if (owner && req.user?.username !== owner.username) {
    res.status(403).json({
      error: 'NOT_OWNER',
      message: 'Esta cuenta no es la dueña de esta PC.',
    });
    return;
  }
  next();
}

// Igual que verifyToken, pero también acepta el token por ?token= en la
// query string -- mismo mirror que ya existe en la central
// (backend/src/middleware/auth.middleware.ts::verifyTokenFromHeaderOrQuery).
// Necesario para <img src>/AVURLAsset (thumbnail/stream): no mandan headers
// custom, solo la URL. FIX 2026-08-16 (Fase 0, Biblioteca LAN): estas rutas
// no pedían NADA de auth antes -- este es el primer paso para poder
// aplicarles requireOwnerOrNoOwnerSet igual que al resto.
export function verifyTokenFromHeaderOrQuery(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
  if (!token) {
    res.status(401).json({ message: 'Token requerido.' });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    req.user = { id: payload.id, username: payload.username, role: payload.role, tier: payload.tier };
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado.' });
  }
}
