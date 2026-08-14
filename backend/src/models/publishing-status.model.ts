import { Schema, model, Document, Types } from 'mongoose';

// LEGACY (2026-08-13): ver publishingStatus.controller.ts y "Estado de
// remediación" en docs/mongo-audit-2026-08-13.md. No agregar nuevos usos.
export interface IPublishingStatus extends Document {
  userId: string;
  fileId: Types.ObjectId;
  title: string;
  tiktok_published: boolean;
  instagram_published: boolean;
  youtube_published: boolean;
  createdAt: Date;
}

const PublishingStatusSchema = new Schema<IPublishingStatus>({
  userId: { type: String, required: true, index: true },
  fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true, unique: true },
  title: { type: String, required: true },
  tiktok_published: { type: Boolean, default: false },
  instagram_published: { type: Boolean, default: false },
  youtube_published: { type: Boolean, default: false },
  createdAt: { type: Date, required: true },
}, { timestamps: false });

export const PublishingStatusModel = model<IPublishingStatus>(
  'PublishingStatus',
  PublishingStatusSchema,
  'publishing_status',
);
