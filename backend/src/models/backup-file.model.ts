import { Schema, model, Document } from 'mongoose';

export interface IBackupFile extends Document {
  userId: string;
  content_id?: string;
  file_name: string;
  platforms: string[];
  platforms_discarded: string[];
  content_status: string;
  tipo_contenido?: string;
  scheduled_date?: Date;
  duracion_segundos?: number;
  resolucion?: string;
  formato?: string;
  fecha_creacion?: Date;
  local_updated_at: Date;
  // SYNC-01 #3 (2026-09-01): timestamp dedicado de cuándo cambiaron
  // platforms/platforms_discarded por última vez -- separado de
  // local_updated_at (que se mueve con CUALQUIER campo del registro). Ver
  // el uso real en local-backend/src/controllers/backup-sync.controller.ts
  // (pullFromCloud). Opcional: registros viejos o que nunca cambiaron su
  // badge desde que existe este campo no lo tienen.
  platforms_updated_at?: Date;
}

const BackupFileSchema = new Schema<IBackupFile>({
  userId:              { type: String, required: true },
  content_id:          { type: String },
  file_name:           { type: String, required: true },
  platforms:           { type: [String], default: [] },
  platforms_discarded: { type: [String], default: [] },
  content_status:      { type: String, default: 'borrador' },
  tipo_contenido:      { type: String },
  scheduled_date:      { type: Date },
  duracion_segundos:   { type: Number },
  resolucion:          { type: String },
  formato:             { type: String },
  fecha_creacion:      { type: Date },
  local_updated_at:    { type: Date, required: true },
  platforms_updated_at: { type: Date },
}, { timestamps: true });

BackupFileSchema.index({ userId: 1, file_name: 1 }, { unique: true });
// Único por usuario + content_id (Fase 6, SYNC-02#1, 2026-08-31) -- antes
// no era único. Ver el mismo comentario extendido en file.model.ts para el
// contexto completo de la reconciliación que hizo falta antes de esto.
//
// C4 (precedencia entre los dos únicos de esta colección, sin resolver del
// todo): un rename que hiciera que el file_name de un documento matcheado
// por content_id colisionara con el file_name de OTRO documento distinto
// dispararía un E11000 en userId_1_file_name_1 al actualizar. Caso raro
// (mismo usuario renombrando a un nombre que ya usa otro archivo suyo) y
// ya amortiguado por diseño: bulkUpsertBackupFiles corre con
// {ordered:false} + try/catch (hallazgo H7), así que ese único documento
// falla en silencio (logueado, no user-facing) sin tumbar el resto del
// push. Aceptado como limitación conocida en vez de construir lógica de
// merge -- retomar si se observa en la práctica.
BackupFileSchema.index(
  { userId: 1, content_id: 1 },
  { unique: true, partialFilterExpression: { content_id: { $type: 'string' } } },
);

export const BackupFileModel = model<IBackupFile>('BackupFile', BackupFileSchema, 'backup_files');
