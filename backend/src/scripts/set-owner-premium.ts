import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { UserModel } from '../models/user.model';

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI || '');
  const result = await UserModel.updateMany({ role: 'todopoderoso' }, { $set: { tier: 'premium' } });
  console.log(`✓ ${result.modifiedCount} usuario(s) todopoderoso actualizados a premium.`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
