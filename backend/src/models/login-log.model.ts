import { Schema, model, Document } from 'mongoose';

export interface ILoginLog extends Document {
  username: string;
  success: boolean;
  failReason?: 'user_not_found' | 'wrong_password' | 'server_error';
  ip: string;
  browser: string;
  os: string;
  device: string;
  userAgent: string;
  at: Date;
}

const loginLogSchema = new Schema<ILoginLog>({
  username:   { type: String, required: true },
  success:    { type: Boolean, required: true },
  failReason: { type: String, enum: ['user_not_found', 'wrong_password', 'server_error'] },
  ip:         { type: String, default: 'unknown' },
  browser:    { type: String, default: 'unknown' },
  os:         { type: String, default: 'unknown' },
  device:     { type: String, default: 'unknown' },
  userAgent:  { type: String, default: '' },
  at:         { type: Date, default: Date.now },
});

// TTL: los logs se eliminan automáticamente después de 90 días
loginLogSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const LoginLogModel = model<ILoginLog>('LoginLog', loginLogSchema);
