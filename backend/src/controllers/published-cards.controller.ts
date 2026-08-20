import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { PublishedCardModel } from '../models/published-card.model';
import { PlatformVideoModel } from '../models/platform-video.model';
import { getVideoStats as getYoutubeVideoStats } from '../services/youtube.service';
import { getMediaStats as getInstagramMediaStats } from '../services/instagram.service';
import { getVideoStatsByIds as getTikTokVideoStats } from '../services/tiktok.service';

const PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const;

// La web no puede consultar el SQLite de la PC. El espejo de PublishedCard es
// útil como fallback, pero no puede ser la fuente de verdad: solo se renovaba
// cuando la app de escritorio abría Calendario y dejaba las métricas (e incluso
// el último video) congeladas en remoto. PlatformVideo se actualiza en cada
// publicación/sync central, así que se prefiere siempre su publicación más
// reciente y se piden sus contadores en vivo al abrir Calendario.
function cardStats(platform: typeof PLATFORMS[number], live: any, previous: any) {
  const thumbnail = live.thumbnail ?? previous?.thumbnail;
  if (platform === 'youtube') return {
    thumbnail,
    viewCount: live.views ?? previous?.viewCount ?? 0,
    likeCount: live.likes ?? previous?.likeCount ?? 0,
    commentCount: live.comments ?? previous?.commentCount ?? 0,
  };
  if (platform === 'instagram') return {
    thumbnail,
    views: live.views ?? previous?.views ?? 0,
    like_count: live.likes ?? previous?.like_count ?? 0,
    comments_count: live.comments ?? previous?.comments_count ?? 0,
  };
  return {
    thumbnail,
    views: live.views ?? previous?.views ?? 0,
    likes: live.likes ?? previous?.likes ?? 0,
    comments: live.comments ?? previous?.comments ?? 0,
    shares: live.shares ?? previous?.shares ?? 0,
  };
}

// GET /api/sync/published-videos
// Devuelve las tarjetas espejadas del usuario (para web/remoto). Siempre las 3 plataformas.
export async function getPublishedCards(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const [docs, latestVideos] = await Promise.all([
      PublishedCardModel.find({ userId }).lean(),
      Promise.all(PLATFORMS.map(platform =>
        PlatformVideoModel.findOne({ userId, platform, status: { $ne: 'deleted' } })
          .sort({ publishedAt: -1 })
          .lean(),
      )),
    ]);
    const byPlatform = new Map(docs.map(d => [d.platform, d]));

    // Conserva datos del espejo (por ejemplo fileId local) cuando sigue siendo
    // el mismo video, pero reemplaza la tarjeta completa si la central ya sabe
    // de una publicación más nueva.
    const cards = PLATFORMS.map((platform, index) => {
      const mirrored: any = byPlatform.get(platform);
      const latest: any = latestVideos[index];
      const mirroredDate = mirrored?.publishedAt ? new Date(mirrored.publishedAt).getTime() : 0;
      const latestDate = latest?.publishedAt ? new Date(latest.publishedAt).getTime() : 0;
      if (!latest || (mirrored && latestDate <= mirroredDate)) return mirrored ?? null;
      const sameVideo = mirrored?.platformId === latest.platformId;
      return {
        platform,
        fileName: sameVideo ? mirrored.fileName ?? null : null,
        fileId: sameVideo ? mirrored.fileId ?? null : null,
        platformId: latest.platformId,
        platformUrl: latest.platformUrl ?? null,
        publishedAt: latest.publishedAt ?? null,
        title: latest.title ?? null,
        status: latest.status ?? null,
        stats: cardStats(platform, latest, sameVideo ? mirrored.stats : undefined),
      };
    });

    const ids = (platform: typeof PLATFORMS[number]) => cards
      .filter((card: any) => card?.platform === platform && card.platformId)
      .map((card: any) => card.platformId);
    const [youtube, instagram, tiktok] = await Promise.all([
      getYoutubeVideoStats(ids('youtube')).catch(() => ({})),
      getInstagramMediaStats(userId, ids('instagram')).catch(() => ({})),
      getTikTokVideoStats(userId, ids('tiktok')).catch(() => ({})),
    ]);
    const liveByPlatform: Record<string, Record<string, any>> = { youtube, instagram, tiktok };

    const refreshed = cards.map((card: any) => {
      if (!card?.platformId) return card;
      const live = liveByPlatform[card.platform]?.[card.platformId];
      return { ...card, stats: cardStats(card.platform, live ?? {}, card.stats) };
    });

    // También persiste el resultado para que, si una API externa está
    // temporalmente caída, la siguiente carga conserve la última métrica buena.
    const ops = refreshed.filter(Boolean).map((card: any) => ({
      updateOne: {
        filter: { userId, platform: card.platform },
        // No reenviar _id/updatedAt que vienen de .lean(): además de ser
        // innecesarios, intentar $set de _id hace fallar el upsert de Mongo.
        update: { $set: {
          userId,
          platform: card.platform,
          fileName: card.fileName ?? null,
          fileId: card.fileId ?? null,
          platformId: card.platformId ?? null,
          platformUrl: card.platformUrl ?? null,
          publishedAt: card.publishedAt ?? null,
          title: card.title ?? null,
          status: card.status ?? null,
          stats: card.stats ?? undefined,
        } },
        upsert: true,
      },
    }));
    if (ops.length > 0) await PublishedCardModel.bulkWrite(ops);

    const result = PLATFORMS.map((platform) => {
      const d: any = refreshed.find((card: any) => card?.platform === platform);
      if (!d) {
        return { platform, fileName: null, fileId: null, platformId: null, platformUrl: null, publishedAt: null };
      }
      return {
        platform,
        fileName:    d.fileName ?? null,
        fileId:      d.fileId ?? null,
        platformId:  d.platformId ?? null,
        platformUrl: d.platformUrl ?? null,
        publishedAt: d.publishedAt ?? null,
        title:       d.title ?? null,
        status:      d.status ?? null,
        stats:       d.stats ?? undefined,
      };
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
}

// POST /api/sync/published-videos
// La app sube (espejo) sus tarjetas para que la web pueda mostrarlas. Upsert por usuario+plataforma.
export async function mirrorPublishedCards(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const cards: any[] = Array.isArray(req.body?.cards) ? req.body.cards : [];
    if (cards.length === 0) { res.json({ ok: true, updated: 0 }); return; }

    const ops = cards
      .filter(c => c && PLATFORMS.includes(c.platform) && c.platformId)
      .map(c => ({
        updateOne: {
          filter: { userId, platform: c.platform },
          update: {
            $set: {
              userId,
              platform:    c.platform,
              fileName:    c.fileName ?? null,
              fileId:      c.fileId ?? null,
              platformId:  c.platformId ?? null,
              platformUrl: c.platformUrl ?? null,
              publishedAt: c.publishedAt ? new Date(c.publishedAt) : null,
              title:       c.title ?? null,
              status:      c.status ?? null,
              stats:       c.stats ?? undefined,
            },
          },
          upsert: true,
        },
      }));

    if (ops.length > 0) await PublishedCardModel.bulkWrite(ops);
    res.json({ ok: true, updated: ops.length });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
}
