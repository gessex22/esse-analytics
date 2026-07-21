import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { UserModel } from './src/models/user.model';

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI || '');
  const username = process.argv[2];
  const password = process.argv[3];
  const hashed = await bcrypt.hash(password, 10);
  const user = await UserModel.create({
    username, password: hashed, role: 'editor', tier: 'premium', hasCloudStorage: true,
  });
  console.log(String(user._id));
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
