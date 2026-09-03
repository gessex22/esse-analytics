import { Schema, model, Document } from 'mongoose';

export type UserRole = 'todopoderoso' | 'editor' | 'visitante';
export type UserTier = 'free' | 'premium';
export type UserStatus = 'active' | 'deleted';
export type Platform = 'youtube' | 'instagram' | 'tiktok';

export interface IUser extends Document {
  username: string;
  password: string;
  role: UserRole;
  tier: UserTier;
  status: UserStatus;
  email?: string;
  youtubeChannel?: string;
  youtubeChannelUrl?: string;
  instagramAccount?: string;
  tiktokAccount?: string;
  // Una cuenta solo se considera "verificada" (cliente real, no curioso)
  // después de vincular su primera plataforma.
  linkedPlatforms: Platform[];
  firstLinkedAt?: Date;
  deletedAt?: Date;
  // Secreto único de la instalación vinculada a esta cuenta. Autoriza operaciones
  // destructivas desde el cliente (reset de contraseña, baja) sin exponer una key
  // global. Solo la instalación dueña conoce este valor. Se borra en cada logout
  // (ver local-backend clearOwner/wipeAll) -- NO usar para nada que necesite
  // sobrevivir logout/login, ver primaryDeviceId más abajo.
  installId?: string;
  // Identidad estable del dispositivo físico que es la "primaria" de esta
  // cuenta -- distinto de installId a propósito (docs/primary-install-corrected-plan-2026-08-14.md):
  // este SÍ debe sobrevivir logout/login de la misma cuenta, install_id no.
  // vacío = sin reclamar todavía (bootstrap: cualquier dispositivo actúa como
  // primaria hasta que uno haga la primera operación de catálogo real, que lo
  // fija sin pedir contraseña -- ver bulkUpsertBackupFiles). Reemplazarlo
  // después de fijado exige POST /api/auth/claim-primary con contraseña.
  primaryDeviceId?: string;
  // Preferencia de tema (se sincroniza con la cuenta para tenerla en cualquier dispositivo).
  theme?: string;
  video_folder?: string;
  // Plan APARTE de tier==='premium' -- aloja bytes de video reales en la
  // central (ver RemoteLibraryVideoModel), a diferencia del mirror de
  // metadata gratis de backup-sync. Sin billing todavía: el owner lo activa
  // a mano desde Usuarios, igual que tier (ver requireCloudStorage).
  hasCloudStorage: boolean;
  // Se incrementa en cambios de seguridad/entitlements. Los JWT emitidos con
  // una versión anterior quedan revocados inmediatamente.
  authVersion: number;
  createdAt: Date;
}

const userSchema = new Schema<IUser>({
  username:           { type: String, required: true, unique: true, lowercase: true },
  password:           { type: String, required: true },
  role:               { type: String, enum: ['todopoderoso', 'editor', 'visitante'], required: true },
  tier:               { type: String, enum: ['free', 'premium'], default: 'free' },
  status:             { type: String, enum: ['active', 'deleted'], default: 'active' },
  email:              { type: String, sparse: true },
  youtubeChannel:     { type: String },
  youtubeChannelUrl:  { type: String },
  instagramAccount:   { type: String },
  tiktokAccount:      { type: String },
  linkedPlatforms:    { type: [String], default: [] },
  firstLinkedAt:      { type: Date },
  deletedAt:          { type: Date },
  installId:          { type: String },
  primaryDeviceId:    { type: String },
  theme:              { type: String },
  video_folder:       { type: String },
  hasCloudStorage:    { type: Boolean, default: false },
  authVersion:        { type: Number, default: 0, min: 0 },
}, { timestamps: { createdAt: true, updatedAt: false } });

export const UserModel = model<IUser>('User', userSchema);

// Marca una plataforma como vinculada y registra la primera vinculación.
export async function markPlatformLinked(userId: string, platform: Platform, accountName?: string) {
  const update: Record<string, any> = {
    $addToSet: { linkedPlatforms: platform },
    $setOnInsert: {},
  };
  const set: Record<string, any> = {};
  if (platform === 'youtube' && accountName)   set.youtubeChannel = accountName;
  if (platform === 'instagram' && accountName) set.instagramAccount = accountName;
  if (platform === 'tiktok' && accountName)    set.tiktokAccount = accountName;
  if (Object.keys(set).length) update.$set = set;

  const user = await UserModel.findById(userId);
  if (!user) return;
  if (!user.firstLinkedAt) {
    set.firstLinkedAt = new Date();
    update.$set = set;
  }
  await UserModel.findByIdAndUpdate(userId, update);
}
