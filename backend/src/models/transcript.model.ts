import { Schema, model, Document } from 'mongoose';

export interface ITranscript extends Document {
  file_id: Schema.Types.ObjectId;
  transcript_text: string;
  language: string;
  tipo_contenido: 'GUION_ESTRUCTURADO' | 'CLIP_RANDOM' | 'CLIP_SIN_VOZ';
  palabras_por_minuto: number;
  processed_at: Date;
}

const TranscriptSchema = new Schema<ITranscript>({
  file_id: { type: Schema.Types.ObjectId, ref: 'File', required: true },
  transcript_text: { type: String, required: true },
  language: { type: String, required: true, default: 'es' },
  tipo_contenido: { type: String, required: true, enum: ['GUION_ESTRUCTURADO', 'CLIP_RANDOM', 'CLIP_SIN_VOZ'] },
  palabras_por_minuto: { type: Number, required: true },
  processed_at: { type: Date, default: Date.now }
});

export const TranscriptModel = model<ITranscript>('Transcript', TranscriptSchema, 'transcripts');