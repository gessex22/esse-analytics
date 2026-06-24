import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { syncYouTubeChannel } from '../services/youtube.service';

async function main() {
  console.log('🔗 Conectando a MongoDB...');
  await mongoose.connect(process.env.MONGO_URI || '');
  console.log('✓ Conectado\n');

  console.log('▶ Iniciando sync de YouTube Shorts...');
  console.log(`  Canal: ${process.env.YOUTUBE_CHANNEL_ID}`);
  console.log(`  API Key: ${process.env.YOUTUBE_API_KEY ? '✓ cargada' : '✗ no encontrada'}\n`);

  try {
    const result = await syncYouTubeChannel();
    console.log('\n✅ Sync completado:');
    console.log(`  Total videos en canal : ${result.total}`);
    console.log(`  Sincronizados         : ${result.shorts}`);
    console.log(`  Guardados/actualizados: ${result.upserted}`);
  } catch (err: any) {
    console.error('\n❌ Error:', err.message);
  }

  await mongoose.disconnect();
  console.log('\nDesconectado.');
}

main();
