import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { AuditEventModel, AuditEventType } from '../models/audit-event.model';

const VALID_TYPES: AuditEventType[] = [
  'login', 'platform_connect', 'platform_disconnect',
  'publish_confirmed', 'calendar_config_updated', 'account_setting_changed',
];

// GET /api/audit-events?limit=30&offset=0&type=&platform=&installationId=
// Mismo shape de paginación que GET /api/sync/history (limit/offset, no
// page/totalPages) -- son el mismo tipo de vista (log cronológico), tiene
// sentido que el cliente los pagine igual. Solo devuelve los eventos DEL
// USUARIO AUTENTICADO -- no hay forma de leer eventos de otra cuenta, ni
// siquiera para 'todopoderoso' (esto es auditoría de la propia cuenta, no
// un panel de administración global).
export async function getAuditEvents(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const limit  = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    const query: Record<string, unknown> = { userId };
    const type = req.query.type as string | undefined;
    if (type && VALID_TYPES.includes(type as AuditEventType)) query.type = type;
    const platform = req.query.platform as string | undefined;
    if (platform && ['youtube', 'instagram', 'tiktok'].includes(platform)) query.platform = platform;
    const installationId = req.query.installationId as string | undefined;
    if (installationId) query.installationId = installationId;

    const [total, docs] = await Promise.all([
      AuditEventModel.countDocuments(query),
      AuditEventModel.find(query).sort({ at: -1 }).skip(offset).limit(limit).lean(),
    ]);

    // installationId/deviceName vistos en esta página -- atajo para poblar
    // el filtro "por dispositivo" en la UI sin pedir un endpoint aparte.
    const devicesSeen = new Map<string, string>();
    for (const d of docs) {
      if (d.installationId && !devicesSeen.has(d.installationId)) {
        devicesSeen.set(d.installationId, d.deviceName || d.source || d.installationId);
      }
    }

    res.json({
      items: docs.map((d: any) => ({
        id: String(d._id),
        type: d.type,
        platform: d.platform ?? null,
        installationId: d.installationId ?? null,
        deviceName: d.deviceName ?? null,
        source: d.source ?? null,
        appVersion: d.appVersion ?? null,
        operationId: d.operationId ?? null,
        entity: d.entity ?? null,
        detail: d.detail ?? null,
        at: d.at,
      })),
      total,
      devices: Object.fromEntries(devicesSeen),
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
}
