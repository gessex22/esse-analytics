import { Schema, model, Document } from 'mongoose';
import { platformStateSchemaFields, IPlatformState } from '../utils/platform-state.util';

export type RemotePlatform = 'youtube' | 'instagram' | 'tiktok';

// Cola de videos pendientes de publicar que vive físicamente en la central
// (storage propio, ver CENTRAL_REMOTE_LIBRARY_DIR) — NO es un mirror de
// metadata como FileModel (ese solo tiene el file_path de la PC del dueño,
// nunca los bytes). Owner-only por ahora (gate real: requireOwner en las
// rutas, no el rol todopoderoso en general — ver auth.middleware.ts).
// El vínculo real archivo↔publicación (platformId/URL) -- platforms/
// platformsDiscarded solo dicen SI/NO por plataforma, nunca guardaron el link
// real. Sin esto no había forma de mostrar/usar el link de un video publicado
// desde Nube (ver historial de escritorio, que sí lo tiene para lo publicado
// desde ahí vía platform_videos local).
export interface IRemoteLibraryPlatformLink {
  platform: RemotePlatform;
  platformId: string;
  platformUrl?: string;
  publishedAt: Date;
}

export interface IRemoteLibraryVideo extends Document {
  userId: string;
  contentId?: string;         // vincula con files.content_id (SQLite local) del mismo video — opcional, no todos los clientes lo mandan (ver Android)
  fileName: string;           // nombre original, solo para mostrar
  // uuid + extensión real en disco -- null cuando el almacenamiento dinámico
  // (ver remote-library-retention.service.ts) ya liberó los bytes del video
  // porque dejó de ser "el próximo a publicar". El documento y la miniatura
  // sobreviven siempre; esto es lo único que puede quedar sin bytes.
  storedFileName: string | null;
  sizeBytes: number;
  durationSeconds?: number;   // lo prueba el cliente (Android), la central no tiene ffmpeg
  resolution?: string;
  formato?: string;
  thumbnailStoredFileName?: string;
  platforms: RemotePlatform[];
  platformsDiscarded: RemotePlatform[];
  platformLinks: IRemoteLibraryPlatformLink[];
  // Mismo concepto que FileModel.platform_states (BUG-2026-08-15-03) --
  // 'confirmed' cuando hay un platformLink real, 'badge_only' cuando es un
  // toggle manual sin link. Sparse hasta la migración.
  platformStates?: IPlatformState<RemotePlatform>[];
  // true cuando estos bytes son una copia deliberada hecha A PARTIR de un
  // archivo local conocido (import server-a-servidor del cliente, o
  // endurecido desde un hardlink -- ver remote-library-retention.service.ts).
  // En ese caso el sweep puede liberarlos igual que a cualquier hardlink
  // (nlink > 1) aunque ya tengan nlink === 1, porque no son la única copia
  // real -- el original sigue viviendo aparte en la biblioteca local. Sin
  // este flag, nlink === 1 se interpreta siempre como "única copia, no
  // tocar", lo que dejaba pegado para siempre a TODO lo que pasara por acá.
  safeToEvict?: boolean;
}

const platformLinkSchema = new Schema<IRemoteLibraryPlatformLink>({
  platform:     { type: String, enum: ['youtube', 'instagram', 'tiktok'], required: true },
  platformId:   { type: String, required: true },
  platformUrl:  { type: String },
  publishedAt:  { type: Date, required: true },
}, { _id: false });

const remoteLibraryVideoSchema = new Schema<IRemoteLibraryVideo>({
  userId:                   { type: String, required: true, index: true },
  contentId:                { type: String, index: true },
  fileName:                 { type: String, required: true },
  storedFileName:           { type: String, default: null },
  sizeBytes:                { type: Number, required: true },
  durationSeconds:          { type: Number },
  resolution:                { type: String },
  formato:                   { type: String },
  thumbnailStoredFileName:   { type: String },
  platforms:                 { type: [String], enum: ['youtube', 'instagram', 'tiktok'], default: [] },
  platformsDiscarded:        { type: [String], enum: ['youtube', 'instagram', 'tiktok'], default: [] },
  platformLinks:             { type: [platformLinkSchema], default: [] },
  platformStates:            { type: [platformStateSchemaFields], default: undefined },
  safeToEvict:               { type: Boolean, default: false },
}, { timestamps: true });

// Un video local es único por cuenta + contentId. El filtro parcial excluye
// documentos históricos de catálogo que no tienen contentId, pero evita que
// carreras de subida creen copias nuevas del mismo archivo.
remoteLibraryVideoSchema.index(
  { userId: 1, contentId: 1 },
  { unique: true, partialFilterExpression: { contentId: { $type: 'string' } } },
);

export const RemoteLibraryVideoModel = model<IRemoteLibraryVideo>(
  'RemoteLibraryVideo',
  remoteLibraryVideoSchema,
  'remote_library_videos',
);
