// Equivalente recortado de backend/src/controllers/backup.controller.ts::applyPlatformPublish --
// el punto único que deja consistentes catálogo/platformVideos/calendario
// cuando "algo se publicó" en el Laboratorio, sin todo el aparato de
// cross-match/backup/remote-library de la central real (fuera de alcance,
// ver README de este paquete).
import { getDb } from '../store/db';
import { newId, mockPlatformUrl, mockThumbnailUrl } from '../lib/ids';
import { Platform } from '../store/types';

export function applyPlatformPublish(userId: string, data: {
  platform: Platform;
  platformId: string;
  platformUrl?: string | null;
  fileName?: string | null;
  title?: string | null;
  publishedAt?: string;
}): void {
  const db = getDb();
  const publishedAt = data.publishedAt ?? new Date().toISOString();

  let file = data.fileName ? db.files.find(f => f.userId === userId && f.fileName === data.fileName) : undefined;
  if (!file && data.fileName) {
    file = { id: newId(), userId, fileName: data.fileName, durationSeconds: 30, createdAt: publishedAt, platforms: [], platformsDiscarded: [] };
    db.files.push(file);
  }
  if (file && !file.platforms.includes(data.platform)) {
    file.platforms.push(data.platform);
    file.platformsDiscarded = file.platformsDiscarded.filter(p => p !== data.platform);
  }

  const existingPv = db.platformVideos.find(pv => pv.userId === userId && pv.platform === data.platform && pv.platformId === data.platformId);
  if (existingPv) {
    existingPv.platformUrl = data.platformUrl ?? existingPv.platformUrl;
    existingPv.title = data.title ?? existingPv.title;
    existingPv.linkedFileId = file?.id ?? existingPv.linkedFileId;
    existingPv.lastSyncedAt = new Date().toISOString();
  } else {
    db.platformVideos.push({
      id: newId(), userId, platform: data.platform, platformId: data.platformId,
      platformUrl: data.platformUrl ?? mockPlatformUrl(data.platform, data.platformId),
      title: data.title ?? data.fileName ?? '', thumbnail: mockThumbnailUrl(data.fileName ?? data.platformId),
      linkedFileId: file?.id ?? null, views: 0, likes: 0, comments: 0,
      publishedAt, lastSyncedAt: new Date().toISOString(),
    });
  }

  // Calendario: "último publicado" avanza, "próximo" salta al siguiente
  // archivo sin resolver para esta plataforma -- mismo criterio (aunque sin
  // toda la lógica de puntero persistido) que syncCalendarAfterPublish real.
  let cfg = db.calendarConfigs.find(c => c.userId === userId && c.platform === data.platform);
  if (!cfg) {
    cfg = { userId, platform: data.platform, lastPublishedTitle: '', lastPublishedDate: '', intervalDays: 3, lastVideoId: null, nextVideoId: null };
    db.calendarConfigs.push(cfg);
  }
  cfg.lastPublishedDate = publishedAt.slice(0, 10);
  cfg.lastPublishedTitle = data.title ?? data.fileName ?? cfg.lastPublishedTitle;
  cfg.lastVideoId = file?.id ?? cfg.lastVideoId;
  const next = db.files.find(f => f.userId === userId && f.id !== file?.id && !f.platforms.includes(data.platform) && !f.platformsDiscarded.includes(data.platform));
  cfg.nextVideoId = next?.id ?? null;
}
