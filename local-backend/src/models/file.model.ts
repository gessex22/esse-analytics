import { Schema, model, Document } from 'mongoose';

export type FileContentStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado';
export type Platform = 'youtube' | 'instagram' | 'tiktok';

export interface IFile extends Document {
  file_name: string;
  file_path: string;
  status: 'PENDIENTE' | 'PROCESANDO' | 'TRANSCRITO' | 'ELIMINADO_DISCO' | 'ERROR';
  content_status: FileContentStatus;
  platforms: Platform[];
  duracion_segundos?: number;
  resolucion?: string;
  formato?: string;
  fecha_creacion?: Date;
  scheduled_date?: Date;
}

const FileSchema = new Schema<IFile>({
  file_name:         { type: String, required: true },
  file_path:         { type: String, required: true },
  status:            { type: String, required: true, enum: ['PENDIENTE', 'PROCESANDO', 'TRANSCRITO', 'ELIMINADO_DISCO', 'ERROR'] },
  content_status:    { type: String, enum: ['publicado', 'borrador', 'procesando', 'descartado'], default: 'borrador' },
  platforms:         { type: [String], enum: ['youtube', 'instagram', 'tiktok'], default: [] },
  duracion_segundos: { type: Number },
  resolucion:        { type: String },
  formato:           { type: String },
  fecha_creacion:    { type: Date },
  scheduled_date:    { type: Date },
}, { timestamps: true });

export const FileModel = model<IFile>('File', FileSchema, 'files');
