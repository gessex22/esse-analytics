import 'dotenv/config';
import mongoose from 'mongoose';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { PlatformVideoModel } from '../models/platform-video.model';
import { applyPlatformPublish } from '../controllers/backup.controller';
import { getVideoPublishedAt as getYoutubePublishedAt } from '../services/youtube.service';
import { getMediaPublishedAt as getInstagramPublishedAt, resolveInstagramMediaId } from '../services/instagram.service';
import { getVideoPublishedAt as getTiktokPublishedAt, resolveTikTokVideoId } from '../services/tiktok.service';

// Backfill puntual para BUG-2026-09-06-02 (docs/bug-reports.md): links reales
// que quedaron guardados en RemoteLibraryVideoModel.platformLinks sin nunca
// disparar applyPlatformPublish (por el guard viejo comparando contra el
// badge en vez del link real) -- invisibles para FileModel/PlatformVideoModel/
// Calendario/Estadísticas hasta hoy.
//
// Seguridad (BUG-2026-09-06-03): NUNCA se usa `link.publishedAt` guardado (para
// un video afectado por el mismo bug de origen, esa fecha puede ser "el
// momento en que se pegó el link", no la publicación real) -- se resuelve la
// fecha real vía la API de cada plataforma ANTES de escribir nada. Si la
// resolución falla (token vencido, sin conexión, video privado), ese platform
// link se deja AFUERA del backfill (no se escribe con una fecha adivinada) y
// se reporta aparte para revisión manual.
//
// Uso: npx tsx src/scripts/backfill-remote-library-links-2026-09-06.ts [--dry-run] [--user=<id>]
const DRY_RUN = process.argv.includes('--dry-run');
const userArg = process.argv.find((a) => a.startsWith('--user='));
const USER_ID = userArg ? userArg.split('=')[1] : '6a3794fb81e6fb54aca72461'; // owner, ver docs/bug-reports.md

// Mismo pre-paso que applyPlatformPublish (backup.controller.ts:1067-1088):
// un link pegado a mano trae el shortcode de Instagram o el publish_id de
// TikTok, no el id numérico/real que exige la API de stats/fecha -- sin
// resolverlo primero, getInstagramPublishedAt/getTiktokPublishedAt fallan
// SIEMPRE para estos casos (confirmado en el primer --dry-run: los 14 que
// cayeron en needsReview eran justo estos, no problemas de token/conexión).
async function resolvePlatformId(platform: string, platformId: string, platformUrl: string | undefined, userId: string): Promise<string> {
  if (platform === 'instagram' && !/^\d+$/.test(platformId)) {
    const resolved = await resolveInstagramMediaId(userId, platformUrl ?? platformId).catch(() => null);
    if (resolved) return resolved;
  }
  if (platform === 'tiktok' && !/^\d+$/.test(platformId)) {
    const resolved = await resolveTikTokVideoId(userId, platformId).catch(() => null);
    if (resolved) return resolved;
  }
  return platformId;
}

async function resolveRealDate(platform: string, platformId: string, userId: string): Promise<Date | null> {
  try {
    if (platform === 'youtube') return await getYoutubePublishedAt(platformId);
    if (platform === 'instagram') return await getInstagramPublishedAt(userId, platformId);
    if (platform === 'tiktok') return await getTiktokPublishedAt(userId, platformId);
  } catch { /* best-effort -- cae a needsReview */ }
  return null;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 });
  console.log(`Conectado. USER_ID=${USER_ID} DRY_RUN=${DRY_RUN}`);

  const videos = await RemoteLibraryVideoModel.find({
    userId: USER_ID,
    'platformLinks.0': { $exists: true },
  }).select('fileName contentId platformLinks').lean();

  console.log(`Videos en Nube con al menos 1 link real: ${videos.length}`);

  const applied: Array<{ fileName: string; platform: string; platformId: string; resolvedDate: string }> = [];
  const skippedAlready: Array<{ fileName: string; platform: string }> = [];
  const needsReview: Array<{ fileName: string; platform: string; platformId: string; platformUrl?: string; contentId?: string }> = [];

  for (const v of videos) {
    for (const link of v.platformLinks ?? []) {
      // Resolver el id real ANTES del chequeo "ya existe" -- PlatformVideoModel
      // siempre guarda el id resuelto (numérico), nunca el shortcode/publish_id
      // crudo que puede traer `link.platformId` (mismo criterio que
      // applyPlatformPublish). Buscar con el crudo daría un falso "no existe"
      // para links que en realidad ya están sincronizados con el id resuelto.
      const resolvedId = await resolvePlatformId(link.platform, link.platformId, link.platformUrl, USER_ID);

      const existing = await PlatformVideoModel.findOne({
        userId: USER_ID, platform: link.platform, platformId: resolvedId,
      }).select('_id').lean();
      if (existing) { skippedAlready.push({ fileName: v.fileName, platform: link.platform }); continue; }

      const realDate = await resolveRealDate(link.platform, resolvedId, USER_ID);
      if (!realDate) {
        needsReview.push({
          fileName: v.fileName, platform: link.platform, platformId: link.platformId,
          platformUrl: link.platformUrl, contentId: v.contentId,
        });
        continue;
      }

      if (!DRY_RUN) {
        await applyPlatformPublish(USER_ID, {
          platform: link.platform,
          platformId: resolvedId,
          platformUrl: link.platformUrl,
          fileName: v.fileName,
          contentId: v.contentId,
          remoteLibraryVideoId: String(v._id),
          publishedAt: realDate,
          matchStatus: 'manual',
        });
      }
      applied.push({ fileName: v.fileName, platform: link.platform, platformId: resolvedId, resolvedDate: realDate.toISOString() });
    }
  }

  console.log(`\n=== ${DRY_RUN ? 'SE APLICARÍAN' : 'APLICADOS'} (${applied.length}) ===`);
  console.table(applied);

  console.log(`\n=== YA ESTABAN SINCRONIZADOS, sin tocar (${skippedAlready.length}) ===`);
  console.table(skippedAlready);

  console.log(`\n=== NECESITAN REVISIÓN MANUAL -- no se tocaron (${needsReview.length}) ===`);
  console.table(needsReview);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
