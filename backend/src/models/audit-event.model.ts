import { Schema, model, Document } from 'mongoose';

// Auditoría central de dispositivos (Fase 5 del plan de estabilidad,
// 2026-08). Distinto de UploadHistoryModel (que guarda el ESTADO actual de
// cada video publicado, con índice único por platform+platformId -- una
// republicación pisa el registro anterior) y de LoginLogModel (logs de
// intentos de login con TTL de 90 días, pensado para seguridad/soporte, no
// para auditoría de largo plazo). Este es un log de EVENTOS append-only sin
// expiración: un documento por cada acción auditable, nunca se actualiza ni
// se borra -- no hay rutas PATCH/DELETE para esta colección, solo
// recordAuditEvent() (server-side, ver audit.service.ts) para escribir y
// GET /api/audit-events para leer.
export type AuditEventType =
  | 'login'
  | 'platform_connect'
  | 'platform_disconnect'
  | 'publish_confirmed'
  | 'calendar_config_updated'
  | 'account_setting_changed'
  // Reasignación explícita de User.installId (Fase 0 de
  // docs/primary-install-implementation-plan-2026-08-14.md) -- distinto de
  // 'login': un login NO reasigna la primaria (antes sí, era el bug).
  | 'primary_install_claimed';

export interface IAuditEvent extends Document {
  userId: string;
  type: AuditEventType;
  platform?: string;   // youtube/instagram/tiktok, si el evento es de una plataforma puntual
  // Identidad del dispositivo que disparó el evento. installationId es el
  // secreto de instalación (desktop: install_id de SQLite via getOrCreateInstallId;
  // iOS: Keychain; Android: DataStore) -- estable entre reinicios de la app,
  // no es una cuenta ni un usuario. deviceName es un snapshot AL MOMENTO del
  // evento (no un join en vivo): si el usuario renombra el dispositivo
  // después, los eventos viejos siguen mostrando el nombre que tenía cuando
  // pasó cada uno -- correcto para una auditoría histórica.
  installationId?: string;
  deviceName?: string;
  source?: string;      // 'desktop' | 'ios' | 'android' | 'web'
  appVersion?: string;
  operationId?: string; // UUID de lote (Fase 2/3) si el evento vino de una publicación en lote
  // Qué se afectó -- forma libre a propósito (un login no afecta una
  // "entidad", una conexión OAuth afecta la plataforma misma, una
  // publicación afecta un video). kind+id+label da contexto sin necesitar
  // un join a otra colección para mostrar el evento en la UI.
  entity?: { kind: string; id: string; label?: string };
  // Detalle sanitizado -- NUNCA JWT/tokens OAuth/contenido de video/rutas de
  // archivo completas (mismo criterio que operationId de Fase 3 y el resto
  // del plan). Pensado para 2-3 campos puntuales (ej. { intervalDays: 3 }
  // en un cambio de calendario), no para volcar el request entero.
  detail?: Record<string, unknown>;
  ip?: string;
  at: Date;
}

const auditEventSchema = new Schema<IAuditEvent>({
  userId:         { type: String, required: true },
  type:           { type: String, required: true },
  platform:       { type: String },
  installationId: { type: String },
  deviceName:     { type: String },
  source:         { type: String },
  appVersion:     { type: String },
  operationId:    { type: String },
  entity: {
    kind:  { type: String },
    id:    { type: String },
    label: { type: String },
  },
  detail: { type: Schema.Types.Mixed },
  ip:     { type: String },
  at:     { type: Date, default: Date.now },
});

auditEventSchema.index({ userId: 1, at: -1 });
auditEventSchema.index({ userId: 1, installationId: 1, at: -1 });

export const AuditEventModel = model<IAuditEvent>('AuditEvent', auditEventSchema, 'audit_events');
