import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { BackupFileModel } from '../models/backup-file.model';
import { TranscriptModel } from '../models/transcript.model';
import { FileModel } from '../models/file.model';
import { UserModel } from '../models/user.model';

// GET /api/backup/files
export async function getBackupFiles(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const [files, user] = await Promise.all([
      BackupFileModel.find({ userId }).lean(),
      UserModel.findById(userId, { video_folder: 1 }).lean(),
    ]);
    res.json({ files, total: files.length, video_folder: user?.video_folder ?? null });
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

    // ── Sincroniza también la colección `files` (FileModel) ────────────────────
    // Es la que leen TODOS los endpoints remotos (catálogo, slim, calendario).
    // Sin esto el remoto queda congelado en el scan viejo. Upsert por
    // {userId, file_name}: conserva el _id (y los enlaces a transcripts/platformvideos).
    await FileModel.bulkWrite(
      incoming.map(f => ({
        updateOne: {
          filter: { userId, file_name: f.file_name },
          update: {
            $set: {
              platforms:           f.platforms           ?? [],
              platforms_discarded: f.platforms_discarded ?? [],
              content_status:      f.content_status      ?? 'borrador',
              scheduled_date:      f.scheduled_date      ?? null,
              duracion_segundos:   f.duracion_segundos   ?? null,
              resolucion:          f.resolucion          ?? null,
              formato:             f.formato             ?? null,
              fecha_creacion:      f.fecha_creacion      ?? null,
            },
            // Solo al crear: campos requeridos que la app no envía (el remoto no
            // hace stream, así que file_path es un placeholder).
            $setOnInsert: { userId, file_name: f.file_name, file_path: f.file_name, status: 'PENDIENTE' },
          },
          upsert: true,
        },
      })),
    );

    // Revivir: un archivo que vuelve en el push pero estaba archivado se reactiva.
    // Hace el sync autocorrectivo (un push parcial previo no deja nada perdido).
    await FileModel.updateMany(
      { userId, file_name: { $in: fileNames }, status: 'ELIMINADO_DISCO' },
      { $set: { status: 'PENDIENTE' } },
    );

    // Reconciliación: si el push es completo (fullSync), lo que ya no está local
    // se marca ELIMINADO_DISCO en el central (los endpoints remotos lo excluyen).
    // No se borra físico → se preservan transcripts/platformvideos enlazados.
    let archived = 0;
    if (req.body.fullSync === true) {
      const r = await FileModel.updateMany(
        { userId, file_name: { $nin: fileNames }, status: { $ne: 'ELIMINADO_DISCO' } },
        { $set: { status: 'ELIMINADO_DISCO' } },
      );
      archived = r.modifiedCount ?? 0;
    }

    const { video_folder } = req.body;
    if (video_folder && typeof video_folder === 'string') {
      await UserModel.findByIdAndUpdate(userId, { video_folder });
    }

    res.json({ updated: toUpdate.length, skipped: incoming.length - toUpdate.length, filesSynced: incoming.length, archived });
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
