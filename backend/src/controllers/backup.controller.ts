import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { BackupFileModel } from '../models/backup-file.model';

// GET /api/backup/files
export async function getBackupFiles(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const files = await BackupFileModel.find({ userId }).lean();
    res.json({ files, total: files.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/backup/files/bulk
// Upserts many records. Last-write-wins by local_updated_at.
export async function bulkUpsertBackupFiles(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const incoming: any[] = req.body.files;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      res.status(400).json({ error: 'files[] requerido' });
      return;
    }

    const fileNames = incoming.map(f => f.file_name);
    const existing = await BackupFileModel.find(
      { userId, file_name: { $in: fileNames } },
      { file_name: 1, local_updated_at: 1 },
    ).lean();
    const tsMap = new Map(existing.map(e => [e.file_name, e.local_updated_at.getTime()]));

    const toUpdate = incoming.filter(f => {
      const existingTs = tsMap.get(f.file_name);
      return !existingTs || existingTs < new Date(f.local_updated_at).getTime();
    });

    if (toUpdate.length > 0) {
      await BackupFileModel.bulkWrite(
        toUpdate.map(f => ({
          updateOne: {
            filter: { userId, file_name: f.file_name },
            update: {
              $set: {
                userId,
                platforms:           f.platforms           ?? [],
                platforms_discarded: f.platforms_discarded ?? [],
                content_status:      f.content_status      ?? 'borrador',
                scheduled_date:      f.scheduled_date      ?? null,
                duracion_segundos:   f.duracion_segundos   ?? null,
                resolucion:          f.resolucion          ?? null,
                formato:             f.formato             ?? null,
                fecha_creacion:      f.fecha_creacion      ?? null,
                local_updated_at:    new Date(f.local_updated_at),
              },
            },
            upsert: true,
          },
        })),
      );
    }

    res.json({ updated: toUpdate.length, skipped: incoming.length - toUpdate.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/backup/status
export async function getBackupStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const total  = await BackupFileModel.countDocuments({ userId });
    const latest = await BackupFileModel.findOne({ userId }, { updatedAt: 1 })
      .sort({ updatedAt: -1 }).lean();
    res.json({ total, lastSync: latest ? (latest as any).updatedAt : null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
