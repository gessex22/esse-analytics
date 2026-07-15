import { Schema, model, Document } from 'mongoose';

export type RemotePlatform = 'youtube' | 'instagram' | 'tiktok';

// Cola de videos pendientes de publicar que vive físicamente en la central
// (storage propio, ver CENTRAL_REMOTE_LIBRARY_DIR) — NO es un mirror de
// metadata como FileModel (ese solo tiene el file_path de la PC del dueño,
// nunca los bytes). Owner-only por ahora (gate real: requireOwner en las
// rutas, no el rol todopoderoso en general — ver auth.middleware.ts).
export interface IRemoteLibraryVideo extends Document {
  userId: string;
  fileName: string;           // nombre original, solo para mostrar
  storedFileName: string;     // uuid + extensión real en disco — evita colisiones
  sizeBytes: number;
  durationSeconds?: number;   // lo prueba el cliente (Android), la central no tiene ffmpeg
  resolution?: string;
  formato?: string;
  thumbnailStoredFileName?: string;
  platforms: RemotePlatform[];
  platformsDiscarded: RemotePlatform[];
}

const remoteLibraryVideoSchema = new Schema<IRemoteLibraryVideo>({
  userId:                   { type: String, required: true, index: true },
  fileName:                 { type: String, required: true },
  storedFileName:           { type: String, required: true },
  sizeBytes:                { type: Number, required: true },
  durationSeconds:          { type: Number },
  resolution:                { type: String },
  formato:                   { type: String },
  thumbnailStoredFileName:   { type: String },
  platforms:                 { type: [String], enum: ['youtube', 'instagram', 'tiktok'], default: [] },
  platformsDiscarded:        { type: [String], enum: ['youtube', 'instagram', 'tiktok'], default: [] },
}, { timestamps: true });

export const RemoteLibraryVideoModel = model<IRemoteLibraryVideo>(
  'RemoteLibraryVideo',
  remoteLibraryVideoSchema,
  'remote_library_videos',
);
