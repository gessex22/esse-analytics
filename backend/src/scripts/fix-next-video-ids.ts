import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db!;
  const configs = await db.collection('platform_config').find({}).toArray();

  for (const c of configs) {
    if (!c.nextVideoId) continue;
    let file: any = null;
    try {
      file = await FileModel.findById(new mongoose.Types.ObjectId(String(c.nextVideoId)))
        .select('file_name').lean();
    } catch { continue; }
    if (!file) { console.log(`${c.platform}: nextVideoId no encontrado`); continue; }

    await db.collection('platform_config').updateOne(
      { platform: c.platform },
      { $set: { nextVideoId: file.file_name } },
    );
    console.log(`${c.platform}: ${c.nextVideoId} → ${file.file_name}`);
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
