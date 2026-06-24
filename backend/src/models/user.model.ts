import { Schema, model, Document } from 'mongoose';

export type UserRole = 'todopoderoso' | 'editor' | 'visitante';

export interface IUser extends Document {
  username: string;
  password: string;
  role: UserRole;
}

const userSchema = new Schema<IUser>({
  username: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  role:     { type: String, enum: ['todopoderoso', 'editor', 'visitante'], required: true },
});

export const UserModel = model<IUser>('User', userSchema);
