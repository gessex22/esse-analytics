// Tipos del store de Laboratorio. Deliberadamente planos (JSON-serializables)
// -- ver db.ts. Los nombres de campo siguen, donde aplica, el mismo shape que
// ya usan backend/ y local-backend/ (UserModel, PlatformVideoModel,
// UploadHistoryModel, publishing_status) para que un cliente que hable con la
// central real y con el Laboratorio no tenga que distinguir el shape, solo la
// URL a la que apunta.

export type UserRole = 'todopoderoso' | 'editor' | 'visitante';
export type UserTier = 'free' | 'premium';
export type Platform = 'youtube' | 'instagram' | 'tiktok';
export type WorkflowMode = 'simple' | 'avanzado';
export type ConnectionStatus = 'connected' | 'expired' | 'disconnected';

export interface PlatformConnection {
  status: ConnectionStatus;
  accountName?: string;
  // Mock, nunca un access_token real -- ver lib/ids.ts (mockToken).
  accessToken?: string;
  expiresAt?: string;
}

export const emptyConnections = (): Record<Platform, PlatformConnection> => ({
  youtube:   { status: 'disconnected' },
  instagram: { status: 'disconnected' },
  tiktok:    { status: 'disconnected' },
});

export interface LabUser {
  id: string;
  username: string;
  // Texto plano a propósito: el Laboratorio no maneja credenciales reales, y el
  // panel admin necesita poder MOSTRAR la contraseña para que quien prueba en
  // el teléfono la tipee. Nunca usar este patrón en backend/ ni local-backend/.
  password: string;
  role: UserRole;
  tier: UserTier;
  isOwner: boolean;
  hasCloudStorage: boolean;
  workflowMode: WorkflowMode;
  status?: 'active' | 'deleted';
  theme?: string;
  installId?: string;
  // Qué escenario predefinido se aplicó por última vez (o 'custom' si se armó
  // a mano desde el panel) -- solo informativo, no condiciona nada del lado
  // del servidor.
  scenario: string;
  connections: Record<Platform, PlatformConnection>;
  createdAt: string;
}

// "Biblioteca": catálogo compartido mock. No son bytes de video reales -- cada
// dispositivo sigue usando su propio player/localizador de archivos; esto es
// solo la metadata que hace que Calendario/Estadísticas/Historial tengan algo
// consistente para mostrar en las 3 plataformas.
export interface LabFile {
  id: string;
  userId: string;
  fileName: string;
  durationSeconds: number;
  createdAt: string;
  platforms: Platform[];
  platformsDiscarded: Platform[];
}

export interface LabPlatformVideo {
  id: string;
  userId: string;
  platform: Platform;
  platformId: string;
  platformUrl: string;
  title: string;
  thumbnail: string;
  linkedFileId: string | null;
  views: number;
  likes: number;
  comments: number;
  publishedAt: string;
  lastSyncedAt: string;
}

export interface LabUploadHistoryItem {
  id: string;
  userId: string;
  platform: Platform;
  platformId: string;
  platformUrl: string | null;
  fileName: string | null;
  title: string | null;
  deviceId: string | null;
  source: string | null;
  operationId: string | null;
  publishedAt: string;
  createdAt: string;
}

export interface LabPublishingStatusItem {
  id: string;
  userId: string;
  fileId: string;
  title: string;
  youtube_published: boolean;
  instagram_published: boolean;
  tiktok_published: boolean;
  createdAt: string;
}

export interface LabCalendarConfig {
  userId: string;
  platform: Platform;
  lastPublishedTitle: string;
  lastPublishedDate: string;
  intervalDays: number;
  lastVideoId: string | null;
  nextVideoId: string | null;
}

// Estado compartido de una publicación simulada -- lo escriben los uploaders
// mock de iOS/Android/Electron a medida que avanzan (progreso, éxito, fallo,
// interrupción) y lo lee cualquier otro dispositivo logueado con la misma
// cuenta. No existe un endpoint equivalente en la central real (ahí cada
// cliente sube directo a la plataforma) -- es una extensión propia del
// Laboratorio para poder probar "publicación lenta/interrumpida" de forma
// observable entre dispositivos.
export type PublishJobStatus =
  | 'queued' | 'uploading' | 'processing' | 'success' | 'failed' | 'canceled' | 'interrupted';

export interface LabPublishJob {
  id: string;
  userId: string;
  platform: Platform;
  fileId: string | null;
  fileName: string;
  status: PublishJobStatus;
  progress: number; // 0-100
  message?: string;
  retryable?: boolean;
  resultPlatformId?: string;
  resultUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LabDb {
  users: LabUser[];
  files: LabFile[];
  platformVideos: LabPlatformVideo[];
  uploadHistory: LabUploadHistoryItem[];
  publishingStatus: LabPublishingStatusItem[];
  calendarConfigs: LabCalendarConfig[];
  publishJobs: LabPublishJob[];
}

export const emptyDb = (): LabDb => ({
  users: [],
  files: [],
  platformVideos: [],
  uploadHistory: [],
  publishingStatus: [],
  calendarConfigs: [],
  publishJobs: [],
});
