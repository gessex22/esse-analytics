import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { UserModel } from '../models/user.model';

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI || '');

  const user = await UserModel.findOne({ role: 'todopoderoso' });
  if (!user) { console.error('No se encontró el usuario todopoderoso.'); process.exit(1); }

  user.password = await bcrypt.hash('sexo', 10);
  await user.save();

  console.log(`✓ Contraseña de '${user.username}' actualizada.`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
