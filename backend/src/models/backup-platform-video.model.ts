import { Schema, model, Document } from 'mongoose';

// Espejo central de la tabla local platform_videos: el vínculo real archivo↔publicación
// (qué platform_id/URL específico corresponde a qué video). Sin esto, el wipe de logout
// (que borra platform_videos en SQLite) dejaba solo el flag "publicado en X" en BackupFile,
// pero perdía para siempre el ID/URL/fecha de la publicación real.
export interface IBackupPlatformVideo extends Document {
  userId: string;
  platform: string;
  platform_id: string;
  platform_url?: string;
  published_at?: Date;
  file_name?: string;      // resuelto desde linked_file_id (los IDs locales no son portables)
  content_id?: string;     // igual que file_name, pero estable ante renombres (ver BackupFile.content_id)
  match_status: string;
  title?: string;
  description?: string;
  local_updated_at: Date;
}

const BackupPlatformVideoSchema = new Schema<IBackupPlatformVideo>({
  userId:           { type: String, required: true },
  platform:         { type: String, required: true },
  platform_id:      { type: String, required: true },
  platform_url:     { type: String },
  published_at:     { type: Date },
  file_name:        { type: String },
  content_id:       { type: String },
  match_status:     { type: String, default: 'sin_match' },
  title:            { type: String },
  description:      { type: String },
  local_updated_at: { type: Date, required: true },
}, { timestamps: true });

BackupPlatformVideoSchema.index({ userId: 1, platform: 1, platform_id: 1 }, { unique: true });

export const BackupPlatformVideoModel = model<IBackupPlatformVideo>(
  'BackupPlatformVideo', BackupPlatformVideoSchema, 'backup_platform_videos',
);
