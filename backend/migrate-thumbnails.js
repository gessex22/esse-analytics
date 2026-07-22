#!/usr/bin/env node
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

require('dotenv').config();

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function getRemoteLibraryDir() {
  const dir = process.env.CENTRAL_REMOTE_LIBRARY_DIR
    || path.join(os.homedir(), '.esse-analytics-central', 'remote-library');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getLocalThumbnailPath(localFileId) {
  const dir = process.env.SQLITE_DIR || path.join(os.homedir(), '.esse-analytics');
  return path.join(dir, 'thumbnails', `${localFileId}.v2.jpg`);
}

function requireFromLocalBackend(pkg) {
  try {
    return require(pkg);
  } catch {
    return require(path.join(__dirname, '..', 'local-backend', 'node_modules', pkg));
  }
}

const THUMB_W = 320, THUMB_H = 180;

function generateThumbnail(ffmpeg, videoPath, outPath, durationSec) {
  const offset = durationSec > 0 ? Math.min(3, durationSec * 0.1) : 1;
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(offset)
      .complexFilter([
        `[0:v]scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H},boxblur=20:5[bg]`,
        `[0:v]scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=decrease[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[out]`,
      ], 'out')
      .outputOptions(['-frames:v', '1', '-update', '1'])
      .on('error', reject)
      .on('end', () => resolve())
      .save(outPath);
  });
}

async function main() {
  const dbPath = process.env.SQLITE_PATH || path.join(os.homedir(), '.esse-analytics', 'esse_local.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No encontré la base local en ${dbPath}.`);
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('No encontré MONGO_URI -- corré esto desde la carpeta backend/.');
    process.exit(1);
  }

  const Database = requireFromLocalBackend('better-sqlite3');
  const ffmpeg = requireFromLocalBackend('fluent-ffmpeg');
  const ffmpegPath = requireFromLocalBackend('ffmpeg-static');
  const ffprobeStatic = requireFromLocalBackend('ffprobe-static');
  function unpackAsarPath(p) { return p.replace('app.asar', 'app.asar.unpacked'); }
  ffmpeg.setFfmpegPath(unpackAsarPath(ffmpegPath));
  ffmpeg.setFfprobePath(unpackAsarPath(ffprobeStatic.path));

  const mongoose = require('mongoose');

  const username = (await prompt('Usuario dueño de los videos: ')).trim().toLowerCase();

  console.log('Conectando a MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);

  const UserModel = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');
  const RemoteLibraryVideoModel = mongoose.model(
    'RemoteLibraryVideo',
    new mongoose.Schema({}, { strict: false, timestamps: true }),
    'remote_library_videos',
  );

  const user = await UserModel.findOne({ username });
  if (!user) {
    console.error(`No existe el usuario "${username}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const userId = user._id.toString();

  const missing = await RemoteLibraryVideoModel.find({
    userId,
    $or: [{ thumbnailStoredFileName: { $exists: false } }, { thumbnailStoredFileName: null }],
  }).select('_id fileName durationSeconds').lean();

  console.log(`${missing.length} videos en Nube sin miniatura.`);
  if (missing.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  const localByName = new Map(
    db.prepare(`SELECT id, file_name, file_path FROM files WHERE status != 'ELIMINADO_DISCO'`).all()
      .map(r => [r.file_name, r]),
  );
  db.close();

  const userDir = path.join(getRemoteLibraryDir(), userId);
  fs.mkdirSync(userDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));

  let ok = 0, skipped = 0, failed = 0;
  for (const [i, video] of missing.entries()) {
    process.stdout.write(`[${i + 1}/${missing.length}] ${video.fileName} ... `);
    const local = localByName.get(video.fileName);
    if (!local || !fs.existsSync(local.file_path)) {
      console.log('sin archivo local, salteado');
      skipped++;
      continue;
    }
    try {
      const cached = getLocalThumbnailPath(local.id);
      let sourceJpg = cached;
      if (!fs.existsSync(cached)) {
        const generated = path.join(tmpDir, `${local.id}.jpg`);
        await generateThumbnail(ffmpeg, local.file_path, generated, video.durationSeconds || 0);
        if (!fs.existsSync(generated)) throw new Error('ffmpeg no generó el archivo');
        sourceJpg = generated;
      }

      const thumbnailStoredFileName = `${crypto.randomUUID()}.jpg`;
      fs.copyFileSync(sourceJpg, path.join(userDir, thumbnailStoredFileName));
      await RemoteLibraryVideoModel.updateOne({ _id: video._id }, { thumbnailStoredFileName });

      console.log(sourceJpg === cached ? 'OK (cache)' : 'OK (generada)');
      ok++;
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      failed++;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nListo. ${ok} con miniatura nueva, ${skipped} salteados, ${failed} con error.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
