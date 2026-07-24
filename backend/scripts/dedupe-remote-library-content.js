#!/usr/bin/env node
// Limpia duplicados históricos por userId + contentId.
// Dry-run: node scripts/dedupe-remote-library-content.js
// Aplicar:  node scripts/dedupe-remote-library-content.js --apply

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const RemoteLibraryVideoModel = mongoose.model(
  'RemoteLibraryVideo',
  new mongoose.Schema({}, { strict: false, timestamps: true }),
  'remote_library_videos',
);
const apply = process.argv.includes('--apply');
const remoteDir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
  || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');

function storedPath(userId, storedFileName) {
  return path.join(remoteDir, String(userId), String(storedFileName));
}

function unionBy(items, key) {
  const out = new Map();
  for (const item of items ?? []) out.set(key(item), item);
  return [...out.values()];
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const groups = await RemoteLibraryVideoModel.aggregate([
    { $match: { contentId: { $type: 'string', $ne: '' } } },
    { $group: { _id: { userId: '$userId', contentId: '$contentId' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  let removed = 0;
  for (const group of groups) {
    const docs = await RemoteLibraryVideoModel.find({ _id: { $in: group.ids } })
      .sort({ storedFileName: -1, updatedAt: -1, _id: -1 }).lean();
    const keeper = docs.find(d => d.storedFileName) ?? docs[0];
    const duplicates = docs.filter(d => String(d._id) !== String(keeper._id));
    console.log(`[${apply ? 'APLICAR' : 'DRY-RUN'}] ${group._id.contentId}: conservar ${keeper._id}, eliminar ${duplicates.length}`);
    if (!apply) continue;

    const thumbnail = keeper.thumbnailStoredFileName
      ?? duplicates.find(d => d.thumbnailStoredFileName)?.thumbnailStoredFileName;
    await RemoteLibraryVideoModel.updateOne({ _id: keeper._id }, { $set: {
      ...(thumbnail ? { thumbnailStoredFileName: thumbnail } : {}),
      platforms: unionBy([keeper, ...duplicates].flatMap(d => d.platforms ?? []), x => x),
      platformsDiscarded: unionBy([keeper, ...duplicates].flatMap(d => d.platformsDiscarded ?? []), x => x),
      platformLinks: unionBy([keeper, ...duplicates].flatMap(d => d.platformLinks ?? []), x => `${x.platform}:${x.platformId}`),
    } });

    for (const duplicate of duplicates) {
      if (duplicate.storedFileName && duplicate.storedFileName !== keeper.storedFileName) {
        try { fs.unlinkSync(storedPath(duplicate.userId, duplicate.storedFileName)); } catch (err) {
          if (err.code !== 'ENOENT') console.warn(`No pude borrar ${duplicate.storedFileName}: ${err.message}`);
        }
      }
      await RemoteLibraryVideoModel.deleteOne({ _id: duplicate._id });
      removed++;
    }
  }

  console.log(`${groups.length} grupos duplicados detectados; ${apply ? `${removed} documentos eliminados` : 'sin cambios (dry-run)'}.`);
  await mongoose.disconnect();
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
