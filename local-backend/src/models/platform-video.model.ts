import { Schema, model, Document, Types } from 'mongoose';

export interface IPlatformVideo extends Document {
  platform: 'youtube' | 'instagram' | 'tiktok';
  platformId: string;
  platformUrl?: string;
  publishedAt?: Date;
  linkedFileId?: Types.ObjectId;
  matchStatus: 'auto' | 'manual' | 'remote' | 'sin_match';
}

const PlatformVideoSchema = new Schema<IPlatformVideo>({
  platform:     { type: String, required: true, enum: ['youtube', 'instagram', 'tiktok'] },
  platformId:   { type: String, required: true },
  platformUrl:  { type: String },
  publishedAt:  { type: Date },
  linkedFileId: { type: Schema.Types.ObjectId, ref: 'File' },
  matchStatus:  { type: String, enum: ['auto', 'manual', 'remote', 'sin_match'], default: 'sin_match' },
}, { timestamps: true });

export const PlatformVideoModel = model<IPlatformVideo>('PlatformVideo', PlatformVideoSchema, 'platformvideos');
