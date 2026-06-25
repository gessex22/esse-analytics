import { Schema, model, Document } from 'mongoose';

export type UserRole = 'todopoderoso' | 'editor' | 'visitante';
export type UserTier = 'free' | 'premium';

export interface IUser extends Document {
  username: string;
  password: string;
  role: UserRole;
  tier: UserTier;
  email?: string;
  youtubeChannel?: string;
  youtubeChannelUrl?: string;
  createdAt: Date;
}

const userSchema = new Schema<IUser>({
  username:           { type: String, required: true, unique: true, lowercase: true },
  password:           { type: String, required: true },
  role:               { type: String, enum: ['todopoderoso', 'editor', 'visitante'], required: true },
  tier:               { type: String, enum: ['free', 'premium'], default: 'free' },
  email:              { type: String, sparse: true },
  youtubeChannel:     { type: String },
  youtubeChannelUrl:  { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });

export const UserModel = model<IUser>('User', userSchema);
