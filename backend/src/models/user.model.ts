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
  // global. Solo la instalación dueña conoce este valor.
  installId?: string;
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
