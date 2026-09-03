import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { UserRole, UserTier } from '../models/user.model';

export interface AuthTokenClaims {
  id: string;
  username: string;
  role: UserRole;
  tier: UserTier;
  hasCloudStorage: boolean;
  authVersion: number;
}

export function signAuthToken(
  user: AuthTokenClaims,
  expiresIn: SignOptions['expiresIn'] = '7d',
): string {
  return jwt.sign(user, env.JWT_SECRET, { expiresIn });
}

export function decodeSignedAuthToken(token: string): (AuthTokenClaims & JwtPayload) | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') return null;
    if (typeof decoded.id !== 'string' || typeof decoded.username !== 'string') return null;
    return decoded as AuthTokenClaims & JwtPayload;
  } catch {
    return null;
  }
}
