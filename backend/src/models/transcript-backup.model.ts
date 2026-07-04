import { Schema, model, Document } from 'mongoose';

// Espejo real de las transcripciones locales (esse-Transcrip), a diferencia de
// `TranscriptModel` (colección legado de Maiden, nunca se le escribe desde acá).
// Sin esto, el wipe de datos locales al cerrar sesión borraba las transcripciones
// sin ninguna copia de respaldo posible.
export interface ITranscriptBackup extends Document {
  userId: string;
  file_name: string;
  transcript_text: string;
  language: string;
  updatedAt: Date;
}

const TranscriptBackupSchema = new Schema<ITranscriptBackup>({
  userId:          { type: String, required: true },
  file_name:       { type: String, required: true },
  transcript_text: { type: String, required: true },
  language:        { type: String, default: 'es' },
}, { timestamps: { createdAt: false, updatedAt: true } });

TranscriptBackupSchema.index({ userId: 1, file_name: 1 }, { unique: true });

export const TranscriptBackupModel = model<ITranscriptBackup>('TranscriptBackup', TranscriptBackupSchema, 'transcript_backups');
