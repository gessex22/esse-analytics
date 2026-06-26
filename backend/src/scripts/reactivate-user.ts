import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { UserModel } from '../models/user.model';

dotenv.config();

// Uso:
//   tsx src/scripts/reactivate-user.ts            → lista cuentas dadas de baja
//   tsx src/scripts/reactivate-user.ts <usuario>  → reactiva esa cuenta
async function run() {
  await mongoose.connect(process.env.MONGO_URI || '');

  const target = process.argv[2];

  if (!target) {
    const deleted = await UserModel.find({ status: 'deleted' }).select('username deletedAt role tier');
    if (deleted.length === 0) {
      console.log('No hay cuentas dadas de baja.');
    } else {
      console.log('Cuentas dadas de baja:');
      for (const u of deleted) {
        console.log(`  - ${u.username}  (rol: ${u.role}, tier: ${u.tier}, baja: ${u.deletedAt})`);
      }
      console.log('\nPara reactivar:  tsx src/scripts/reactivate-user.ts <usuario>');
    }
    await mongoose.disconnect();
    return;
  }

  const user = await UserModel.findOne({ username: target.toLowerCase() });
  if (!user) { console.error(`Usuario '${target}' no encontrado.`); process.exit(1); }

  user.status = 'active';
  user.deletedAt = undefined;
  // Limpiar el secreto de instalación para que la cuenta pueda re-vincularse limpia.
  user.installId = undefined;
  await user.save();

  console.log(`✓ Cuenta '${user.username}' reactivada (status: active, installId limpiado).`);
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
