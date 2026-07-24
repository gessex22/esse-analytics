#!/usr/bin/env node
// Fix puntual: youtube/tiktok en platform_config apuntaban a videos YA
// publicados (stale) -- almacenamiento dinámico había protegido/endurecido
// esos en vez de los que de verdad hacen falta. Este script:
//   1. Sube a Biblioteca remota los 2 videos reales-próximos que faltaban
//      (fresh copy, no hardlink -- safeToEvict: true, mismo criterio que
//      ensureNextVideoInRemoteLibrary/hardenIfHardlinked).
//   2. Corrige platform_config (nextVideoId + nextRemoteLibraryVideoId).
//   3. Marca safeToEvict: true en los 3 docs endurecidos ANTES de que ese
//      campo existiera, para que el próximo sweep los pueda liberar ahora
//      que dejaron de ser "el próximo".
//
// Uso: node fix-stale-next-videos.js           (dry-run)
//      node fix-stale-next-videos.js --apply

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const USER_ID = '6a3794fb81e6fb54aca72461';

const NEW_NEXT = [
  { platform: 'youtube', localId: 19578, fileName: 'final - stargate.mp4', filePath: 'C:\\Users\\Gessemberg\\Desktop\\publicados\\final - stargate.mp4', contentId: 'f97d1a85-a2af-405d-bd16-d2f02d363132', durationSeconds: 35.341, resolution: '1440x2560', formato: 'VERTICAL' },
  { platform: 'tiktok',  localId: 19504, fileName: 'final - oneplus.mp4',  filePath: 'C:\\Users\\Gessemberg\\Desktop\\publicados\\final - oneplus.mp4',  contentId: '7fc4c16f-5489-407d-9750-a8f90416edd8', durationSeconds: 75.255875, resolution: '1080x1920', formato: 'VERTICAL' },
];

// Docs endurecidos antes de que safeToEvict existiera -- ya no son "el
// próximo" real de nada (ya publicados en todas las plataformas que decían
// faltarles), hay que permitir que el sweep los libere.
const STALE_HARDENED_FILENAMES = ['final - face id windows.mp4', 'iphone-tiktok.mp4'];

async function main() {
  const apply = process.argv.includes('--apply');
  const mongoose = require('mongoose');
  const RemoteLibraryVideoModel = mongoose.model('RemoteLibraryVideo',
    new mongoose.Schema({}, { strict: false, timestamps: true }), 'remote_library_videos');

  await mongoose.connect(process.env.MONGO_URI);
  const remoteLibraryDir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');

  console.log('=== Paso 1: subir stargate/oneplus (si no están ya) ===');
  const newIds = {};
  for (const v of NEW_NEXT) {
    const existing = await RemoteLibraryVideoModel.findOne({ userId: USER_ID, contentId: v.contentId }).lean();
    if (existing) {
      console.log(`[YA EXISTE] ${v.fileName} -> ${existing._id}`);
      newIds[v.platform] = String(existing._id);
      continue;
    }
    if (!fs.existsSync(v.filePath)) { console.log(`[ERROR] no encuentro el archivo local: ${v.filePath}`); continue; }

    const stat = fs.statSync(v.filePath);
    const storedFileName = `${crypto.randomUUID()}${path.extname(v.filePath) || '.mp4'}`;
    const destPath = path.join(remoteLibraryDir, USER_ID, storedFileName);

    console.log(`[${apply ? 'SUBIENDO' : 'SIMULARÍA SUBIR'}] ${v.fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB) -> ${storedFileName}`);
    if (apply) {
      fs.mkdirSync(path.join(remoteLibraryDir, USER_ID), { recursive: true });
      fs.copyFileSync(v.filePath, destPath);
      const doc = await RemoteLibraryVideoModel.create({
        userId: USER_ID, contentId: v.contentId, fileName: v.fileName, storedFileName,
        sizeBytes: stat.size, durationSeconds: v.durationSeconds, resolution: v.resolution, formato: v.formato,
        platforms: [], platformsDiscarded: [], safeToEvict: true,
      });
      newIds[v.platform] = String(doc._id);
      console.log(`  -> creado ${doc._id}`);
    }
  }

  console.log('\n=== Paso 2: corregir platform_config ===');
  const db = mongoose.connection.db;
  for (const v of NEW_NEXT) {
    const id = newIds[v.platform];
    console.log(`[${apply ? 'ACTUALIZANDO' : 'SIMULARÍA ACTUALIZAR'}] platform_config.${v.platform}.nextVideoId = "${v.fileName}", nextRemoteLibraryVideoId = ${id ?? '(pendiente de subir)'}`);
    if (apply && id) {
      await db.collection('platform_config').updateOne(
        { userId: USER_ID, platform: v.platform },
        { $set: { nextVideoId: v.fileName, nextRemoteLibraryVideoId: id } },
      );
    }
  }

  console.log('\n=== Paso 3: marcar safeToEvict en los endurecidos viejos ===');
  const staleDocs = await RemoteLibraryVideoModel.find({ userId: USER_ID, fileName: { $in: STALE_HARDENED_FILENAMES } }).select('fileName safeToEvict').lean();
  for (const d of staleDocs) {
    console.log(`[${apply ? 'MARCANDO' : 'SIMULARÍA MARCAR'}] ${d.fileName} safeToEvict=true (era ${d.safeToEvict ?? false})`);
  }
  if (apply && staleDocs.length) {
    await RemoteLibraryVideoModel.updateMany(
      { userId: USER_ID, fileName: { $in: STALE_HARDENED_FILENAMES } },
      { $set: { safeToEvict: true } },
    );
  }

  if (!apply) console.log('\nDry-run -- no se tocó nada. Para aplicar: node fix-stale-next-videos.js --apply');
  await mongoose.disconnect();
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
