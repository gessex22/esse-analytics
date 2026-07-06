import { Schema, model, Document } from 'mongoose';

// Espejo de las preferencias/estado de calendario de la instalación local (SQLite:
// app_config.workflow_mode + platform_config). Los IDs de video son locales a cada
// SQLite, así que se guardan por file_name (igual que import-calendar) y se
// resuelven a IDs locales recién al hacer pull en la máquina que corresponda.
interface IPlatformConfigEntry {
  platform: string;
  last_published_title?: string | null;
  last_published_date?: string | null;
  interval_days?: number | null;
  last_video_name?: string | null;
  next_video_name?: string | null;
}

export interface IBackupConfig extends Document {
  userId: string;
  workflow_mode: string | null;
  platform_configs: IPlatformConfigEntry[];
}

const PlatformConfigEntrySchema = new Schema<IPlatformConfigEntry>({
  platform:              { type: String, required: true },
  last_published_title:  { type: String },
  last_published_date:   { type: String },
  interval_days:         { type: Number },
  last_video_name:       { type: String },
  next_video_name:       { type: String },
}, { _id: false });

const BackupConfigSchema = new Schema<IBackupConfig>({
  userId:           { type: String, required: true, unique: true },
  workflow_mode:    { type: String, default: null },
  platform_configs: { type: [PlatformConfigEntrySchema], default: [] },
}, { timestamps: true });

export const BackupConfigModel = model<IBackupConfig>('BackupConfig', BackupConfigSchema, 'backup_configs');
