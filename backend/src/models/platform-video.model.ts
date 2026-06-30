import { Schema, model, Document, Types } from 'mongoose';

export type SyncPlatform = 'youtube' | 'instagram' | 'tiktok';
export type PlatformVideoStatus = 'public' | 'private' | 'unlisted' | 'deleted';

export interface IPlatformVideo extends Document {
  platform: SyncPlatform;
  platformId: string;           // ID nativo de la plataforma (ej: YouTube video ID)
  platformUrl: string;
  title: string;
  description: string;
  publishedAt: Date;
  durationSeconds: number;
  thumbnail: string;            // URL del thumbnail de la plataforma
  views: number;
  likes: number;
  comments: number;
  status: PlatformVideoStatus;
  linkedFileId?: Types.ObjectId; // referencia al archivo local — null hasta que se vincule
  matchStatus?: 'auto_duration' | 'auto_text' | 'auto_code' | 'manual' | 'revisar_manual' | 'sin_match' | 'remote';
  matchScore?: number;
  matchCandidates?: string[];  // IDs de archivos locales candidatos (guardados por el script Python)
  lastSyncedAt: Date;
}

const platformVideoSchema = new Schema<IPlatformVideo>({
  platform:       { type: String, required: true, enum: ['youtube', 'instagram', 'tiktok'] },
  platformId:     { type: String, required: true },
  platformUrl:    { type: String, required: true },
  title:          { type: String, default: '' },
  description:    { type: String, default: '' },
  publishedAt:    { type: Date, required: true },
  durationSeconds:{ type: Number, default: 0 },
  thumbnail:      { type: String, default: '' },
  views:          { type: Number, default: 0 },
  likes:          { type: Number, default: 0 },
  comments:       { type: Number, default: 0 },
  status:         { type: String, enum: ['public', 'private', 'unlisted', 'deleted'], default: 'public' },
  linkedFileId:   { type: Schema.Types.ObjectId, ref: 'File', default: null },
  matchStatus:      { type: String, enum: ['auto_duration','auto_text','auto_code','manual','revisar_manual','sin_match','remote'] },
  matchScore:       { type: Number },
  matchCandidates:  { type: [String], default: undefined },
  lastSyncedAt:     { type: Date, default: Date.now },
});

// Índice único por plataforma + ID nativo (evita duplicados en re-sync)
platformVideoSchema.index({ platform: 1, platformId: 1 }, { unique: true });

export const PlatformVideoModel = model<IPlatformVideo>('PlatformVideo', platformVideoSchema);
