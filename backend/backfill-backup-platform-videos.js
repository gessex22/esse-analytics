#!/usr/bin/env node
// Historial (GET /api/sync/history) ahora tiene versión central para verse igual
// desde Android/web remoto (antes solo existía en local-backend, leyendo la SQLite).
// La central se sirve de BackupPlatformVideoModel (backup_platform_videos), el
// espejo que sube local-backend en cada push -- pero ese espejo solo tiene lo que
// alguna instalación llegó a pushear, y quedó en apenas ~22 registros. Este script
// lo completa con lo que ya está resuelto en PlatformVideoModel (platformvideos,
// la colección que alimenta Sincronizar/cross-match y Estadísticas), que tiene
// bastante más cobertura histórica. Aditivo: solo agrega (platform, platform_id)
// que todavía no existan en backup_platform_videos, nunca pisa nada.

const readline = require('readline');
require('dotenv').config();

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('No encontré MONGO_URI -- corré esto desde la carpeta backend/.');
    process.exit(1);
  }

  const mongoose = require('mongoose');
  console.log('Conectando a MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);

  const UserModel = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');
  const PlatformVideoModel = mongoose.model('PlatformVideo', new mongoose.Schema({}, { strict: false }), 'platformvideos');
  const BackupPlatformVideoModel = mongoose.model('BackupPlatformVideo', new mongoose.Schema({}, { strict: false }), 'backup_platform_videos');
  const FileModel = mongoose.model('CentralFile', new mongoose.Schema({}, { strict: false }), 'files');

  const username = (await prompt('Usuario dueño de los videos: ')).trim().toLowerCase();
  const user = await UserModel.findOne({ username });
  if (!user) {
    console.error(`No existe el usuario "${username}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const userId = user._id.toString();

  const pvs = await PlatformVideoModel.find({ userId, linkedFileId: { $ne: null } }).lean();
  console.log(`${pvs.length} registros en platformvideos con archivo vinculado.`);

  const existing = await BackupPlatformVideoModel.find({ userId }).select('platform platform_id').lean();
  const existingSet = new Set(existing.map(e => `${e.platform}::${e.platform_id}`));
  console.log(`${existing.length} ya existentes en backup_platform_videos (no se tocan).`);

  const toAdd = pvs.filter(pv => !existingSet.has(`${pv.platform}::${pv.platformId}`));
  console.log(`${toAdd.length} candidatos nuevos.`);

  const fileIds = [...new Set(toAdd.map(pv => String(pv.linkedFileId)))];
  const files = await FileModel.find({ _id: { $in: fileIds } }).select('file_name content_id').lean();
  const fileById = new Map(files.map(f => [String(f._id), f]));

  let added = 0, skippedNoFile = 0;
  const ops = [];
  for (const pv of toAdd) {
    const file = fileById.get(String(pv.linkedFileId));
    if (!file) { skippedNoFile++; continue; }
    ops.push({
      updateOne: {
        filter: { userId, platform: pv.platform, platform_id: pv.platformId },
        update: {
          $set: {
            userId,
            platform:         pv.platform,
            platform_id:      pv.platformId,
            platform_url:     pv.platformUrl ?? null,
            published_at:     pv.publishedAt ?? null,
            file_name:        file.file_name,
            content_id:       file.content_id ?? null,
            match_status:     'manual',
            title:            pv.title ?? null,
            description:      pv.description ?? null,
            local_updated_at: new Date(),
          },
        },
        upsert: true,
      },
    });
    added++;
  }

  if (ops.length > 0) await BackupPlatformVideoModel.bulkWrite(ops);

  console.log(`\nListo. ${added} agregados, ${skippedNoFile} sin archivo local para resolver el nombre (no tocados).`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
