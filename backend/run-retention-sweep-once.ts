#!/usr/bin/env -S npx tsx
// Corre el sweep de almacenamiento dinámico UNA sola vez, sin levantar el
// servidor completo (evita el problema de instancias duplicadas de la vez
// pasada). Uso: npx tsx run-retention-sweep-once.ts
import './src/load-env';
import mongoose from 'mongoose';
import { runRemoteLibraryRetentionSweep } from './src/services/remote-library-retention.service';

async function main() {
  await mongoose.connect(process.env.MONGO_URI || '');
  const result = await runRemoteLibraryRetentionSweep();
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
