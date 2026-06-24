/**
 * Seed publishing_status from files collection.
 * Idempotent — skips existing docs by fileId.
 *
 * Run: tsx src/scripts/seedPublishingStatus.ts
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { FileModel } from '../models/file.model';
import { PublishingStatusModel } from '../models/publishing-status.model';

dotenv.config();

// Most-recently-published video per platform (inclusive cut-off).
// All files at and below this index (oldest) get marked published.
// Uses substring match after normalizing — must match the actual file_name in DB.
const CUTOFFS: Record<string, string> = {
  tiktok:    'garantia',
  instagram: 'lag minecraft',
  youtube:   'mac neo',
};

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function seed() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set in .env');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log('Connected to MongoDB');

  if (process.argv.includes('--reset')) {
    const deleted = await PublishingStatusModel.deleteMany({});
    console.log(`Reset: deleted ${deleted.deletedCount} existing publishing_status docs`);
  }

  // Same sort order as the dashboard (fecha_creacion DESC → newest first)
  const files = await FileModel.find({}).sort({ createdAt: -1 }).lean();
  console.log(`Found ${files.length} files`);

  // Resolve cut-off indices (search by normalized substring)
  const indices: Record<string, number> = {};
  for (const [platform, cutoff] of Object.entries(CUTOFFS)) {
    const normalCutoff = normalize(cutoff);
    const idx = files.findIndex(f => normalize(f.file_name).includes(normalCutoff));
    indices[platform] = idx;
    if (idx < 0) {
      console.warn(`  WARNING: cutoff "${cutoff}" not found for ${platform} — all will be false`);
    } else {
      console.log(`  ${platform} cutoff → index ${idx} (${files[idx].file_name})`);
    }
  }

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    const existing = await PublishingStatusModel.findOne({ fileId: file._id });
    if (existing) { skipped++; continue; }

    // files with index >= cutoff (older or equal) are already published
    const tiktok_published    = indices.tiktok    >= 0 && i >= indices.tiktok;
    const instagram_published = indices.instagram >= 0 && i >= indices.instagram;
    const youtube_published   = indices.youtube   >= 0 && i >= indices.youtube;

    await PublishingStatusModel.create({
      fileId: file._id,
      title: file.file_name,
      tiktok_published,
      instagram_published,
      youtube_published,
      createdAt: (file as any).createdAt ?? new Date(),
    });
    created++;
  }

  console.log(`Done: ${created} created, ${skipped} skipped`);
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
