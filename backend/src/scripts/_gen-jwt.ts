import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { UserModel } from '../models/user.model';
dotenv.config();
mongoose.connect(process.env.MONGO_URI || '').then(async () => {
  const user = await UserModel.findOne({ username: (process.env.OWNER_USERNAME || 'esse').toLowerCase() }).lean();
  if (!user) { console.error('no user'); process.exit(1); }
  const token = jwt.sign({ id: String(user._id), username: user.username, role: user.role, tier: user.tier }, process.env.JWT_SECRET || 'esse_secret_key_2024', { expiresIn: '2h' });
  console.log(token);
  await mongoose.disconnect();
});
