import { Schema, model, Document } from 'mongoose';

export type FileContentStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado';

export type Platform = 'youtube' | 'instagram' | 'tiktok';

export interface IFile extends Document {
  userId?: string;       // dueño del archivo (scoping por cuenta). Legacy = sin dueño → backfill al owner.
  content_id?: string;   // identidad estable ante renombres/reimportaciones -- ver BackupFileModel y
                          // files.content_id en SQLite local. Registros viejos no lo tienen (sparse).
  file_name: string;
  file_path: string;
  status: 'PENDIENTE' | 'PROCESANDO' | 'TRANSCRITO' | 'ELIMINADO_DISCO' | 'ERROR';
  content_status: FileContentStatus;
  platforms: Platform[];
  platforms_discarded: Platform[];
  publishCode?: string;  // código único para sync futuro — se incluye en descripción de YT/IG/TK
  duracion_segundos?: number;
  resolucion?: string;
  formato?: string;
  fecha_creacion?: Date;  // fecha real del archivo en disco (mtime) — la llena el escáner
  scheduled_date?: Date;  // fecha programada de publicación (opcional)
}

const FileSchema = new Schema<IFile>({
  userId: { type: String, index: true },
  content_id: { type: String, sparse: true },
  file_name: { type: String, required: true },
  file_path: { type: String, required: true },
  status: { type: String, required: true, enum: ['PENDIENTE', 'PROCESANDO', 'TRANSCRITO', 'ELIMINADO_DISCO', 'ERROR'] },
  content_status: {
    type: String,
    enum: ['publicado', 'borrador', 'procesando', 'descartado'],
    default: 'borrador',
  },
  platforms: {
    type: [String],
    enum: ['youtube', 'instagram', 'tiktok'],
    default: [],
  },
  platforms_discarded: {
    type: [String],
    enum: ['youtube', 'instagram', 'tiktok'],
    default: [],
  },
  publishCode: { type: String, sparse: true },
  duracion_segundos: { type: Number },
  resolucion: { type: String },
  formato: { type: String },
  fecha_creacion: { type: Date },
  scheduled_date: { type: Date },
}, { timestamps: true });

// Índice compuesto para el lookup por identidad estable (bulkUpsertBackupFiles,
// applyPlatformPublish) -- sparse porque los registros viejos no tienen content_id.
FileSchema.index({ userId: 1, content_id: 1 }, { sparse: true });

export const FileModel = model<IFile>('File', FileSchema, 'files');