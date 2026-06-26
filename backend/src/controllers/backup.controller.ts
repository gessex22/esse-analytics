import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { BackupFileModel } from '../models/backup-file.model';
import { TranscriptModel } from '../models/transcript.model';
import { FileModel } from '../models/file.model';

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

// GET /api/backup/transcripts
export async function getBackupTranscripts(_req: AuthRequest, res: Response): Promise<void> {
  try {
    const transcripts = await TranscriptModel.find(
      { transcript_text: { $exists: true, $ne: '' } },
      { file_id: 1, transcript_text: 1, language: 1 },
    ).lean();

    const fileIds = transcripts.map(t => t.file_id);
    const files   = await FileModel.find({ _id: { $in: fileIds } }, { _id: 1, file_name: 1 }).lean();
    const nameMap = new Map(files.map(f => [String(f._id), f.file_name]));

    const result = transcripts
      .map(t => ({
        file_name:       nameMap.get(String(t.file_id)),
        transcript_text: t.transcript_text,
        language:        (t as any).language ?? 'es',
      }))
      .filter(t => t.file_name);

    res.json({ transcripts: result, total: result.length });
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
