import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { BackupFileModel } from '../models/backup-file.model';
import { TranscriptModel } from '../models/transcript.model';
import { FileModel } from '../models/file.model';
import { UserModel } from '../models/user.model';
import { IdeaCentral } from '../models/ideacentral';

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

const hasData = (arr: any): boolean => Array.isArray(arr) && arr.length > 0;

// POST /api/backup/files/bulk
// Upserts many records. Last-write-wins by local_updated_at — PERO un archivo que
// llega sin platforms/platforms_discarded (p.ej. un re-escaneo de disco tras un wipe,
// que no puede saber dónde se publicó cada video) NUNCA pisa un registro que en la
// nube sí tiene esa info, aunque su timestamp sea más nuevo. Así el backup real
// sobrevive a un catálogo reconstruido desde cero.
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
      { file_name: 1, local_updated_at: 1, platforms: 1, platforms_discarded: 1 },
    ).lean();
    const existingMap = new Map(existing.map(e => [e.file_name, e]));

    // Para cada archivo entrante, decide si el valor de platforms que se aplica es
    // el que llegó (incoming) o el que ya había en la nube (protegido).
    function resolvePlatforms(f: any, ex: typeof existing[number] | undefined) {
      const incomingEmpty = !hasData(f.platforms) && !hasData(f.platforms_discarded);
      const existingHasData = !!ex && (hasData(ex.platforms) || hasData(ex.platforms_discarded));
      if (incomingEmpty && existingHasData) {
        return { platforms: ex!.platforms, platforms_discarded: ex!.platforms_discarded, protected: true };
      }
      return { platforms: f.platforms ?? [], platforms_discarded: f.platforms_discarded ?? [], protected: false };
    }

    const toUpdate = incoming.filter(f => {
      const ex = existingMap.get(f.file_name);
      const existingTs = ex?.local_updated_at?.getTime();
      const isNewer = !existingTs || existingTs < new Date(f.local_updated_at).getTime();
      // Si no es más nuevo, no hay nada que actualizar (comportamiento previo).
      // Si SÍ es más nuevo pero vendría vacío sobre un registro con datos, igual lo
      // dejamos pasar (para no perder otros campos legítimos), resolvePlatforms se
      // encarga de proteger específicamente platforms/platforms_discarded.
      return isNewer;
    });

    if (toUpdate.length > 0) {
      await BackupFileModel.bulkWrite(
        toUpdate.map(f => {
          const ex = existingMap.get(f.file_name);
          const { platforms, platforms_discarded } = resolvePlatforms(f, ex);
          return {
            updateOne: {
              filter: { userId, file_name: f.file_name },
              update: {
                $set: {
                  userId,
                  platforms,
                  platforms_discarded,
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
          };
        }),
      );
    }

    // ── Sincroniza también la colección `files` (FileModel) ────────────────────
    // Es la que leen TODOS los endpoints remotos (catálogo, slim, calendario).
    // Sin esto el remoto queda congelado en el scan viejo. Upsert por
    // {userId, file_name}: conserva el _id (y los enlaces a transcripts/platformvideos).
    // Misma protección: platforms vacío nunca pisa uno ya poblado en FileModel.
    const fileModelExisting = await FileModel.find(
      { userId, file_name: { $in: fileNames } },
      { file_name: 1, platforms: 1, platforms_discarded: 1 },
    ).lean();
    const fileModelExistingMap = new Map(fileModelExisting.map(e => [e.file_name, e]));

    await FileModel.bulkWrite(
      incoming.map(f => {
        const ex = fileModelExistingMap.get(f.file_name);
        const { platforms, platforms_discarded } = resolvePlatforms(f, ex as any);
        return {
          updateOne: {
            filter: { userId, file_name: f.file_name },
            update: {
              $set: {
                platforms,
                platforms_discarded,
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
        };
      }),
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
      { file_id: 1, transcript_text: 1, language: 1, tipo_contenido: 1 },
    ).lean();

    const fileIds = transcripts.map(t => t.file_id);
    const files   = await FileModel.find({ _id: { $in: fileIds } }, { _id: 1, file_name: 1 }).lean();
    const nameMap = new Map(files.map(f => [String(f._id), f.file_name]));

    const result = transcripts
      .map(t => ({
        file_name:       nameMap.get(String(t.file_id)),
        transcript_text: t.transcript_text,
        language:        (t as any).language ?? 'es',
        tipo_contenido:  (t as any).tipo_contenido ?? null,
      }))
      .filter(t => t.file_name);

    res.json({ transcripts: result, total: result.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/backup/ideas-centrales
// Trae las ideas agrupadas (Mongo, legado) resolviendo file_id → file_name para que
// el local-backend pueda matchear contra su propia tabla `files` por nombre.
export async function getBackupIdeas(_req: AuthRequest, res: Response): Promise<void> {
  try {
    const ideas = await IdeaCentral.find({}).lean();

    const allFileIds = new Set<string>();
    for (const idea of ideas) {
      for (const v of idea.videos_vinculados ?? []) allFileIds.add(String(v.file_id));
    }
    const files   = await FileModel.find({ _id: { $in: Array.from(allFileIds) } }, { _id: 1, file_name: 1 }).lean();
    const nameMap = new Map(files.map(f => [String(f._id), f.file_name]));

    const result = ideas
      .map(idea => ({
        idea_nucleo:          idea.idea_nucleo,
        resumen_visual:       idea.resumen_visual,
        status:               (idea as any).status ?? 'borrador',
        video_principal_name: nameMap.get(String(idea.video_principal_id)) ?? null,
        videos: (idea.videos_vinculados ?? [])
          .map(v => ({
            file_name:       nameMap.get(String(v.file_id)),
            similitud_guion: v.similitud_guion ?? 0,
            rol:             v.rol ?? 'RELACIONADO',
          }))
          .filter(v => v.file_name),
      }))
      .filter(idea => idea.videos.length > 0);

    res.json({ ideas: result, total: result.length });
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
