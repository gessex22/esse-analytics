import { AuditEventModel, AuditEventType } from '../models/audit-event.model';
import { errorName, logger } from '../utils/logger';

export interface RecordAuditEventParams {
  userId: string;
  type: AuditEventType;
  platform?: string;
  installationId?: string;
  deviceName?: string;
  source?: string;
  appVersion?: string;
  operationId?: string;
  entity?: { kind: string; id: string; label?: string };
  detail?: Record<string, unknown>;
  ip?: string;
}

// Best-effort a propósito: un evento de auditoría que falla al escribirse
// NUNCA debe tumbar el flujo principal (login, publicar, conectar una
// plataforma) -- mismo criterio que ya usa LoginLogModel.create(...).catch(
// () => {}) en auth.controller.ts. Loguea el error a consola para poder
// notar si la auditoría se está cayendo silenciosamente, pero no relanza.
export async function recordAuditEvent(params: RecordAuditEventParams): Promise<void> {
  try {
    await AuditEventModel.create({ ...params, at: new Date() });
  } catch (err: any) {
    logger.error('audit_event_write_failed', { type: params.type, errorName: errorName(err) });
  }
}
