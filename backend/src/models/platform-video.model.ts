import { Schema, model, Document, Types } from 'mongoose';

// 'facebook' solo aparece como destino de crossposting (Reel publicado en la
// Página al subir a IG) — no participa del matching ni de las vistas de sync.
export type SyncPlatform = 'youtube' | 'instagram' | 'tiktok' | 'facebook';
export type PlatformVideoStatus = 'public' | 'private' | 'unlisted' | 'deleted';

export interface IPlatformVideo extends Document {
  userId: string;
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
  // Emparejado manual ENTRE plataformas (YouTube ↔ Instagram ↔ TikTok) — un mismo
  // video de contenido publicado en varias redes. Es independiente de linkedFileId:
  // no lo pisa ni depende de él. Una vez agrupadas, vincular una sola al archivo
  // local (linkedFileId) alcanzaría para resolver las demás por transitividad.
  crossMatchGroupId?: string;
  lastSyncedAt: Date;
}

const platformVideoSchema = new Schema<IPlatformVideo>({
  userId:         { type: String, required: true, index: true },
  platform:       { type: String, required: true, enum: ['youtube', 'instagram', 'tiktok', 'facebook'] },
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
  crossMatchGroupId:{ type: String, default: null, index: true },
  lastSyncedAt:     { type: Date, default: Date.now },
});

// Índice único por usuario + plataforma + ID nativo (evita duplicados en re-sync)
platformVideoSchema.index({ userId: 1, platform: 1, platformId: 1 }, { unique: true });

export const PlatformVideoModel = model<IPlatformVideo>('PlatformVideo', platformVideoSchema);
