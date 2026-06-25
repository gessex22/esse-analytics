import { Schema, model, Document, Types } from 'mongoose';

export interface IPublishingStatus extends Document {
  fileId: Types.ObjectId;
  title: string;
  tiktok_published: boolean;
  instagram_published: boolean;
  youtube_published: boolean;
  createdAt: Date;
}

const PublishingStatusSchema = new Schema<IPublishingStatus>({
  fileId:              { type: Schema.Types.ObjectId, ref: 'File', required: true, unique: true },
  title:               { type: String, required: true },
  tiktok_published:    { type: Boolean, default: false },
  instagram_published: { type: Boolean, default: false },
  youtube_published:   { type: Boolean, default: false },
  createdAt:           { type: Date, required: true },
}, { timestamps: false });

export const PublishingStatusModel = model<IPublishingStatus>(
  'PublishingStatus', PublishingStatusSchema, 'publishing_status',
);
