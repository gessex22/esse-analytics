import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { PublishedCardModel } from '../models/published-card.model';

const PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const;

// GET /api/sync/published-videos
// Devuelve las tarjetas espejadas del usuario (para web/remoto). Siempre las 3 plataformas.
export async function getPublishedCards(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const docs = await PublishedCardModel.find({ userId }).lean();
    const byPlatform = new Map(docs.map(d => [d.platform, d]));

    const result = PLATFORMS.map((platform) => {
      const d = byPlatform.get(platform);
      if (!d) {
        return { platform, fileName: null, platformId: null, platformUrl: null, publishedAt: null };
      }
      return {
        platform,
        fileName:    d.fileName ?? null,
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
