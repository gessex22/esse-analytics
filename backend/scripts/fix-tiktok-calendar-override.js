#!/usr/bin/env node
// Corrige el override de Calendario (platform_config) para TikTok del usuario
// 6a3794fb81e6fb54aca72461: tenía lastPublishedDate="2026-08-14" (hoy) y
// lastPublishedTitle="final - accesorio que mas venden.mp4", pero ese video
// se publicó en realidad el 2026-04-18 (recién linkeado hoy vía "Editar
// links", sin fecha local conocida -- ver fix en
// local-backend/src/controllers/video.controller.ts). El video REAL más
// reciente en TikTok es "Los rucos con IA..." del 2026-08-11.
//
// Dry-run: node scripts/fix-tiktok-calendar-override.js
// Aplicar:  node scripts/fix-tiktok-calendar-override.js --apply

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const USER_ID = '6a3794fb81e6fb54aca72461';
const CORRECT = {
  lastPublishedDate: '2026-08-11',
  lastPublishedTitle: 'Los rucos con IA se sienten cómo thanos con las gemas del\ninfinito ',
  lastVideoId: '6a752b786674a6b95db4f0f3',
};

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI no está seteado');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const apply = process.argv.includes('--apply');

  const before = await db.collection('platform_config').findOne({ platform: 'tiktok', userId: USER_ID });
  console.log('ANTES:', JSON.stringify(before, null, 2));

  if (!before) {
    console.log('No se encontró el documento -- nada que corregir.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${apply ? 'APLICANDO' : 'DRY-RUN (pasá --apply para escribir de verdad)'}:`, CORRECT);

  if (apply) {
    const result = await db.collection('platform_config').updateOne(
      { platform: 'tiktok', userId: USER_ID },
      { $set: CORRECT },
    );
    console.log('modifiedCount:', result.modifiedCount);
    const after = await db.collection('platform_config').findOne({ platform: 'tiktok', userId: USER_ID });
    console.log('DESPUÉS:', JSON.stringify(after, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
