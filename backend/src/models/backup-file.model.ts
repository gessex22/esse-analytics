import { Schema, model, Document } from 'mongoose';

export interface IBackupFile extends Document {
  userId: string;
  file_name: string;
  platforms: string[];
  platforms_discarded: string[];
  content_status: string;
  scheduled_date?: Date;
  duracion_segundos?: number;
  resolucion?: string;
  formato?: string;
  fecha_creacion?: Date;
  local_updated_at: Date;
}

const BackupFileSchema = new Schema<IBackupFile>({
  userId:              { type: String, required: true },
  file_name:           { type: String, required: true },
  platforms:           { type: [String], default: [] },
  platforms_discarded: { type: [String], default: [] },
  content_status:      { type: String, default: 'borrador' },
  scheduled_date:      { type: Date },
  duracion_segundos:   { type: Number },
  resolucion:          { type: String },
  formato:             { type: String },
  fecha_creacion:      { type: Date },
  local_updated_at:    { type: Date, required: true },
}, { timestamps: true });

BackupFileSchema.index({ userId: 1, file_name: 1 }, { unique: true });

export const BackupFileModel = model<IBackupFile>('BackupFile', BackupFileSchema, 'backup_files');
