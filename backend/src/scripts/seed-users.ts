import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { UserModel } from '../models/user.model';

dotenv.config();

async function seed() {
  await mongoose.connect(process.env.MONGO_URI || '');

  const users = [
    { username: 'esse',   password: 'abcd', role: 'todopoderoso' as const },
    { username: 'editor', password: '1234', role: 'editor'        as const },
  ];

  for (const u of users) {
    const exists = await UserModel.findOne({ username: u.username });
    if (exists) {
      console.log(`Usuario '${u.username}' ya existe, omitiendo.`);
      continue;
    }
    const hashed = await bcrypt.hash(u.password, 10);
    await UserModel.create({ username: u.username, password: hashed, role: u.role });
    console.log(`✓ Usuario '${u.username}' (${u.role}) creado.`);
  }

  await mongoose.disconnect();
  console.log('Seed completado.');
}

seed().catch((err) => { console.error(err); process.exit(1); });
