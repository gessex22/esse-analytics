import { Response } from 'express';
import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth.middleware';
import { syncYouTubeChannel, getYouTubeVideos, getRecentYouTubeVideosLive, getVideoStats as getYoutubeVideoStats } from '../services/youtube.service';
import { getRecentInstagramMedia, getMediaStats, PlatformRecentItem } from '../services/instagram.service';
import { getRecentTikTokVideos, getVideoStatsByIds as getTiktokVideoStats, resolveTikTokVideoId } from '../services/tiktok.service';
import { getValidToken as getValidTikTokToken } from './tiktok-upload.controller';
import { PlatformVideoModel, SyncPlatform } from '../models/platform-video.model';
import { UploadHistoryModel } from '../models/upload-history.model';
import { FileModel } from '../models/file.model';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { applyPlatformPublish } from './backup.controller';
import { recordAuditEvent } from '../services/audit.service';

export const triggerYouTubeSync = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await syncYouTubeChannel(req.user!.id);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err.message });
  }
};

export const getYouTubeList = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const data  = await getYouTubeVideos(req.user!.id, page, limit);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

export const getSyncStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const youtube   = await PlatformVideoModel.countDocuments({ userId, platform: 'youtube' });
    const instagram = await PlatformVideoModel.countDocuments({ userId, platform: 'instagram' });
    const tiktok    = await PlatformVideoModel.countDocuments({ userId, platform: 'tiktok' });
    const linked    = await PlatformVideoModel.countDocuments({ userId, linkedFileId: { $ne: null } });
    const revisar   = await PlatformVideoModel.countDocuments({ userId, matchStatus: 'revisar_manual' });
    const sinMatch  = await PlatformVideoModel.countDocuments({ userId, matchStatus: 'sin_match' });
    res.json({ youtube, instagram, tiktok, linked, revisar, sinMatch });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/review — lista de videos YT pendientes de revisión manual con sus candidatos
export const getReviewList = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const page  = parseInt(req.query.page  as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip  = (page - 1) * limit;

    const total = await PlatformVideoModel.countDocuments({ userId, matchStatus: 'revisar_manual' });
    const items = await PlatformVideoModel.find({ userId, matchStatus: 'revisar_manual' })
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Poblar candidatos: matchCandidates guarda IDs como strings
    const enriched = await Promise.all(items.map(async (pv) => {
      const candidateIds = (pv.matchCandidates ?? []).map((id: string) => {
        try { return new Types.ObjectId(id); } catch { return null; }
      }).filter(Boolean);

      const candidates = candidateIds.length
        ? await FileModel.find({ _id: { $in: candidateIds }, userId })
            .select('file_name duracion_segundos fecha_creacion formato')
            .lean()
        : [];

      return { ...pv, candidates };
    }));

    res.json({ total, page, totalPages: Math.ceil(total / limit), items: enriched });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/review/:pvId/link — confirma un match manual
export const confirmLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { pvId } = req.params;
    const { fileId } = req.body;
    const userId = req.user!.id;
    if (!fileId) { res.status(400).json({ message: 'fileId requerido' }); return; }

    const updated = await PlatformVideoModel.findOneAndUpdate({ _id: pvId, userId }, {
      linkedFileId: new Types.ObjectId(fileId),
      matchStatus: 'manual',
      $unset: { matchCandidates: '' },
    });
    if (!updated) { res.status(404).json({ message: 'No encontrado.' }); return; }

    // Confirmar el match acá solo tocaba PlatformVideoModel -- el badge (Videos),
    // el link del pull del PC, el Calendario y Nube nunca se enteraban de este
    // vínculo. Sin file_name no hay mucho que propagar (los otros stores
    // matchean por nombre), pero best-effort igual si el archivo no lo tiene.
    const linkedFile = await FileModel.findById(fileId).select('file_name content_id').lean();
    if (linkedFile) {
      await applyPlatformPublish(userId, {
        platform: updated.platform, platformId: updated.platformId, platformUrl: updated.platformUrl,
        fileName: linkedFile.file_name,
        title: updated.title, publishedAt: updated.publishedAt, matchStatus: 'manual',
      });
      // BUG real encontrado 2026-08-15: confirmar un match a mano nunca
      // escribía en UploadHistoryModel (a diferencia de recordUploadEvent,
      // que sí) -- el Dashboard ("Último video publicado") depende
      // exclusivamente de esa colección, y con ella vacía siempre caía al
      // fallback de "el más reciente por fecha_creacion" (la fecha del
      // ARCHIVO, no de la publicación), mostrando el video equivocado. En
      // esta cuenta, TODAS las publicaciones históricas se resolvieron por
      // este camino (link a mano), así que UploadHistoryModel nunca tuvo ni
      // un solo registro. Ver docs/bug-reports.md.
      await UploadHistoryModel.updateOne(
        { userId, platform: updated.platform, platformId: updated.platformId },
        {
          $setOnInsert: {
            userId, platform: updated.platform, platformId: updated.platformId,
            deviceId: 'confirm-link', source: 'confirm-link',
            platformUrl: updated.platformUrl ?? null,
            fileName: linkedFile.file_name,
            contentId: linkedFile.content_id ?? null,
            title: updated.title ?? null,
            publishedAt: updated.publishedAt ?? new Date(),
          },
        },
        { upsert: true },
      ).catch(() => { /* best-effort -- un fallo acá no debe invalidar el link ya confirmado */ });
    }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/review/:pvId/orphan — marca como huérfano
export const markOrphan = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { pvId } = req.params;
    const userId = req.user!.id;
    const updated = await PlatformVideoModel.findOneAndUpdate({ _id: pvId, userId }, {
      matchStatus: 'sin_match',
      $unset: { matchCandidates: '' },
    });
    if (!updated) { res.status(404).json({ message: 'No encontrado.' }); return; }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/sync/platform-link/:fileId/:platform
// Quita la asociación central sin borrar el video publicado de la red. Esto
// evita que un link eliminado en Electron vuelva a aparecer al sincronizar.
export const unlinkPlatform = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { fileId, platform } = req.params;
    const userId = req.user!.id;
    if (!['youtube', 'instagram', 'tiktok', 'facebook'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' }); return;
    }
    const file = await FileModel.findOneAndUpdate(
      { _id: fileId, userId },
      { $pull: { platforms: platform, platforms_discarded: platform } },
      { new: true },
    ).select('_id');
    if (!file) { res.status(404).json({ message: 'Archivo no encontrado' }); return; }
    await PlatformVideoModel.updateMany(
      { userId, linkedFileId: file._id, platform },
      { $set: { linkedFileId: null, matchStatus: 'sin_match' } },
    );
    res.json({ ok: true, fileId, platform });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/platform-recent/:platform?limit=20&cursor=... — página de videos
// EN VIVO de la plataforma, para elegir manualmente cuáles son "el mismo video"
// entre redes (emparejado cruzado). `cursor` es lo que devolvió la página
// anterior en `nextCursor` — hace falta paginar de verdad (no solo traer un lote
// fijo) porque cada plataforma publica a un ritmo distinto: si TikTok publica
// mucho más seguido que YouTube/Instagram, sus últimos 20 pueden cubrir apenas
// unos días mientras las otras cubren meses, y nunca se llega a la misma fecha
// sin poder seguir retrocediendo. Excluye los que ya quedaron agrupados antes.
export const getPlatformRecent = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { platform } = req.params as { platform: SyncPlatform };
    const limit  = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const userId = req.user!.id;

    if (!['youtube', 'instagram', 'tiktok'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' });
      return;
    }

    let items: PlatformRecentItem[];
    let nextCursor: string | null;
    if (platform === 'youtube') {
      // En vivo directo del canal — no depende de que "Re-sincronizar" se haya
      // corrido antes (ver getRecentYouTubeVideosLive).
      const yt = await getRecentYouTubeVideosLive(limit, cursor);
      items = yt.items;
      nextCursor = yt.nextCursor;
    } else if (platform === 'instagram') {
      const page = await getRecentInstagramMedia(userId, limit, cursor);
      items = page.items;
      nextCursor = page.nextCursor;
    } else {
      const page = await getRecentTikTokVideos(userId, limit, cursor);
      items = page.items;
      nextCursor = page.nextCursor;
    }

    // Filtra los que ya quedaron agrupados en un match cruzado previo.
    const already = await PlatformVideoModel.find({
      userId, platform, platformId: { $in: items.map(i => i.platformId) },
      crossMatchGroupId: { $ne: null },
    }).select('platformId').lean();
    const excluded = new Set(already.map(d => d.platformId));

    // Red de seguridad contra loops: si la plataforma devolviera el MISMO
    // cursor recibido (bug de su lado) o una página vacía que igual dice
    // "hay más", se corta acá tratándolo como fin de lista -- así el cliente
    // (iOS/Android/desktop) nunca entra en un "Cargar más" que no avanza.
    const safeNextCursor = (nextCursor && nextCursor !== cursor && items.length > 0) ? nextCursor : null;

    res.json({ items: items.filter(i => !excluded.has(i.platformId)), nextCursor: safeNextCursor });
  } catch (err: any) {
    // NO_AUTH (sin token, token vencido) -- mismo código que el resto de los
    // endpoints de youtube/instagram/tiktok-upload.controller.ts, así el
    // cliente puede distinguirlo de un error genérico y ofrecer reconectar
    // en vez de solo "Reintentar". Cualquier otro fallo real (API caída,
    // error de la plataforma) sigue como 500 -- ninguno de los dos casos se
    // convierte en {items:[], nextCursor:null} como pasaba antes.
    if (err.message === 'NO_AUTH') {
      res.status(401).json({ error: 'NO_AUTH', message: 'Conectá la cuenta de esta plataforma primero' });
      return;
    }
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/cross-match — confirma que 2 o 3 videos (uno por plataforma) son
// el mismo contenido publicado en varias redes. NO toca linkedFileId/matchStatus:
// ese vínculo con el archivo local es independiente de este agrupamiento.
export const confirmCrossMatch = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const items = (req.body?.items ?? []) as Array<{
      platform: SyncPlatform; platformId: string; title?: string; thumbnail?: string;
      publishedAt?: string; platformUrl?: string | null;
    }>;

    if (!Array.isArray(items) || items.length < 2) {
      res.status(400).json({ message: 'Se necesitan al menos 2 videos para emparejar.' });
      return;
    }
    const platforms = new Set(items.map(i => i.platform));
    if (platforms.size !== items.length) {
      res.status(400).json({ message: 'No se puede emparejar dos videos de la misma plataforma.' });
      return;
    }

    // Si alguno ya pertenece a un grupo, se reutiliza ese id — así uniones
    // sucesivas terminan en el mismo grupo en vez de fragmentarse en varios.
    const existing = await PlatformVideoModel.find({
      userId,
      $or: items.map(i => ({ platform: i.platform, platformId: i.platformId })),
    }).lean();
    const groupId = existing.find(e => e.crossMatchGroupId)?.crossMatchGroupId ?? randomUUID();

    for (const item of items) {
      await PlatformVideoModel.findOneAndUpdate(
        { userId, platform: item.platform, platformId: item.platformId },
        {
          $set: {
            userId,
            platform:          item.platform,
            platformId:        item.platformId,
            platformUrl:       item.platformUrl ?? '',
            title:             item.title ?? '',
            publishedAt:       item.publishedAt ? new Date(item.publishedAt) : new Date(),
            thumbnail:         item.thumbnail ?? '',
            crossMatchGroupId: groupId,
            lastSyncedAt:      new Date(),
          },
        },
        { upsert: true }
      );
    }

    res.json({ ok: true, groupId });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

const CROSS_MATCH_TARGET_PLATFORMS = ['youtube', 'instagram', 'tiktok'] as const;

// Rediseño 2026-09-01 (bug real reportado): la elegibilidad original solo
// miraba `platforms` (badge de publicado), nunca `platforms_discarded` — un
// archivo con 2 confirmadas + 1 descartada a propósito quedaba PARA SIEMPRE
// "incompleto" a ojos de este endpoint, aunque no le faltara nada por hacer.
// Ahora "resuelto" = las 3 plataformas están DECIDIDAS (publicada O
// descartada), no solo publicadas. Con eso, el filtro de 3 niveles (1/2/3)
// se simplifica a 2: `resolvedOnly=false` (cola de pendientes) y
// `resolvedOnly=true` ("Resuelto", las 3 decididas). Se cae la opción
// intermedia "2+" -- no aportaba mucho y complicaba la UI.
// $expr+$setIsSubset en vez de enumerar combinaciones a mano (como antes)
// porque acá el chequeo es sobre la UNIÓN de dos arrays, no solo uno --
// enumerar pares ya no alcanza.
//
// Rediseño 2026-09-04 (queja real reportada 2026-09-03, ver
// docs/instant-matches-stats-plan-2026-08-31.md y memoria de sesión
// "crossmatch_ux_regression_pending"): ambas ramas entraban con actividad en
// `platforms` O `platforms_discarded`, sin exigir que `platforms` tuviera
// algo -- un archivo 100% descartado en las 3 (nunca publicado en ninguna)
// calificaba igual (como pendiente antes, como "Resuelto" ahora), aunque
// nunca tuvo nada vinculable que hacer en esta pantalla: no es un candidato,
// es un archivo que nunca entró al flujo de publicación. Ahora las DOS
// ramas exigen actividad REAL de publicación (`platforms` no vacío) --
// un archivo 100% descartado no aparece en ningún filtro. Además, la cola
// de pendientes excluye lo ya resuelto (antes esta vista mezclaba pendientes
// y resueltos, empujando los pendientes viejos al fondo detrás de todo lo
// ya cerrado).
const hasRealPublish = { platforms: { $in: CROSS_MATCH_TARGET_PLATFORMS } };

// Rediseño 2026-09-06 (pedido explícito del usuario, mismo día que
// BUG-2026-09-06-02/04): los rediseños de arriba miran solo BADGES
// (platforms/platforms_discarded) para decidir "pendiente" vs "resuelto" --
// pero lo que esta pantalla resuelve de verdad es el LINK real, no el
// badge. Un badge se pone en segundos con un toggle; un link real cuesta
// buscar el video en la plataforma y pegarlo -- por eso el usuario pide
// usar los badges como señal de "esto ya se decidió" (rápido, adelantado) y
// priorizar por cuánto FALTA vincular en comparación con lo ya decidido, no
// por fecha de creación del archivo.
//
// `decidedCount` = badges decididos (publicado O descartado), 0-3.
// `pendingLinkCount`/`linkedCount` = de las plataformas PUBLICADAS (badge,
// no descarte -- un descarte nunca necesita link), cuántas siguen sin/con
// un `PlatformVideoModel` real vinculado (`linkedFileId`). Se usa el link
// real (`linkedSet`, resuelto contra `PlatformVideoModel` más abajo), NO
// `platform_states` -- verificado en vivo contra producción: `platform_states`
// no está poblado para gran parte del catálogo histórico (videos viejos
// marcados con badge mucho antes de que ese campo existiera, BUG-2026-08-15-03),
// así que usarlo daba 1061 "pendientes" (todo ese catálogo viejo colando de
// nuevo) en vez de los ~65 reales -- mismo síntoma que motivó el rediseño de
// 2026-09-04, por una causa distinta.
//
// "Pendientes" exige: (a) LAS 3 decididas -- no 2 (corregido 2026-09-06,
// versión anterior de este comentario decía "al menos 2"; el pedido real
// del usuario fue siempre "3 badges" o "2 badges + 1 descartada", ambos
// suman 3 decididas -- 2 decididas con la tercera plataforma TODAVÍA sin
// tocar no es candidato, sigue siendo trabajo de publicar, no de
// vincular). Antes de esto, "1 sola decidida" alcanzaba y eso es justo lo
// que inundaba la cola con la primera red publicada (ver
// crossmatch_ux_regression_pending_2026_09_03) -- exigir las 3 lo
// resuelve de raíz, no solo lo mitiga. (b) al menos 1 link pendiente de
// esas decisiones (si no falta ningún link, no hay nada que hacer acá), Y
// (c) al menos 1 link YA resuelto -- sin esto, el catálogo histórico sin
// ningún link (nunca se pensó vincular, ver arriba) volvía a colar
// completo. Un archivo "en progreso" (ya tiene algún link real, le falta
// otro) es un candidato genuino; uno sin NINGÚN link real todavía es
// indistinguible de catálogo viejo que nunca buscó vincularse -- no
// aparece acá, sigue disponible por los otros caminos manuales
// (Sincronizar → pestañas por plataforma, Editar links en Videos).
// "Resuelto" exige las 3 decididas Y cero links pendientes -- ya no alcanza
// con las 3 badges puestas, tienen que estar de verdad vinculadas (o
// descartadas, que no necesita link) -- antes un archivo con las 3 badges
// pero 0 links reales cerraba acá como "Resuelto", exactamente al revés: es
// el candidato perfecto para esta pantalla, no algo ya cerrado.
function decidedCount(f: { platforms?: string[]; platforms_discarded?: string[] }): number {
  return (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0);
}

function pendingLinkCount(f: { _id: any; platforms?: string[] }, linkedSet: Set<string>): number {
  return (f.platforms ?? []).filter((p) => !linkedSet.has(`${f._id}:${p}`)).length;
}

function linkedCount(f: { platforms?: string[] }, pending: number): number {
  return (f.platforms?.length ?? 0) - pending;
}

// GET /api/sync/cross-match/candidates?limit=20&page=1&minPlatforms=1|3 — en
// vez de adivinar a ciegas con las 3 ruedas por separado, arranca de lo que
// YA se sabe local: los archivos con actividad en al menos una plataforma
// (files.platforms/platforms_discarded). Antes exigía siempre las 3
// publicadas (`$all` sobre platforms) — un archivo recién publicado en 1
// sola red no aparecía como candidato hasta tener las otras 2, aunque ya
// hubiera trabajo real para mostrar. Fase 7 / Paso 2
// (docs/instant-matches-stats-plan-2026-08-31.md): el candidato debe poder
// aparecer desde la primera publicación real, con las plataformas restantes
// mostradas como pendientes — la UI (CandidateCard/PlatformSlotChip en
// SyncPanel.tsx) ya soporta estados parciales, no asumía que las 3
// estuvieran presentes de entrada. `minPlatforms=3` (alias de "Resuelto")
// mantiene el nombre del query param por compatibilidad con clientes que ya
// lo mandan (iOS/Android), pero su significado cambió: ver
// buildEligibilityFilter arriba. Cualquier valor > 1 mapea a "resuelto".
// Por cada uno, resuelve qué plataformas ya tienen un platform_video vinculado
// (linkedFileId) y cuáles todavía faltan/están descartadas — así el usuario
// solo busca lo que realmente falta, no todo desde cero.
export const getCrossMatchCandidates = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const limit  = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const page   = Math.max(1, parseInt(req.query.page as string) || 1);
    const resolvedOnly = (parseInt(req.query.minPlatforms as string) || 1) > 1;

    // Filtro amplio en Mongo (barato, usa el mismo índice de siempre sobre
    // `platforms`) -- el filtro exacto (decidedCount/pendingLinkCount) y el
    // orden de "Pendientes" se calculan en JS abajo, ver el comentario
    // arriba de decidedCount/pendingLinkCount.
    const broad = await FileModel.find({ userId, ...hasRealPublish })
      .select('file_name fecha_creacion duracion_segundos platforms platforms_discarded')
      .lean();

    // linkedSet: qué pares (fileId, platform) ya tienen un PlatformVideoModel
    // real vinculado -- fuente de verdad para pendingLinkCount/linkedCount
    // (ver comentario arriba, NO usar platform_states acá). Consulta aparte
    // de la que arma `resolved` más abajo (esa es solo de la página actual,
    // ésta necesita el set completo para poder filtrar/ordenar ANTES de
    // paginar).
    const linkedForEligibility = await PlatformVideoModel.find({
      userId,
      linkedFileId: { $in: broad.map((f) => f._id) },
      platform: { $in: CROSS_MATCH_TARGET_PLATFORMS },
    }).select('linkedFileId platform').lean();
    const linkedSet = new Set(linkedForEligibility.map((l) => `${l.linkedFileId}:${l.platform}`));

    const eligible = broad.filter((f) => {
      const decided = decidedCount(f);
      const pending = pendingLinkCount(f, linkedSet);
      if (resolvedOnly) return decided === 3 && pending === 0;
      return decided === 3 && pending >= 1 && linkedCount(f, pending) >= 1;
    });

    // 2026-09-06: dentro de "Pendientes", prioriza por menos links
    // pendientes primero (lo más cerca de terminar sube -- 3 badges con 1
    // solo link faltante es el candidato ideal) y, a igualdad, por más
    // decisiones ya tomadas; fecha_creacion como último desempate (FIFO,
    // ver rediseño 2026-09-04 -- sigue evitando que lo último publicado
    // tape pendientes viejos con el mismo pendingLinkCount). "Resuelto"
    // sigue por fecha descendente (lo cerrado más reciente arriba, sin
    // cambios).
    eligible.sort((a, b) => {
      if (resolvedOnly) {
        return new Date(b.fecha_creacion as any).getTime() - new Date(a.fecha_creacion as any).getTime();
      }
      const pendingDiff = pendingLinkCount(a, linkedSet) - pendingLinkCount(b, linkedSet);
      if (pendingDiff !== 0) return pendingDiff;
      const decidedDiff = decidedCount(b) - decidedCount(a);
      if (decidedDiff !== 0) return decidedDiff;
      return new Date(a.fecha_creacion as any).getTime() - new Date(b.fecha_creacion as any).getTime();
    });

    const total = eligible.length;
    const files = eligible.slice((page - 1) * limit, (page - 1) * limit + limit);

    const fileIds = files.map(f => f._id);
    const linked = await PlatformVideoModel.find({ userId, linkedFileId: { $in: fileIds } })
      .select('linkedFileId platform platformId platformUrl title thumbnail')
      .lean();
    const byFile = new Map<string, typeof linked>();
    for (const pv of linked) {
      const key = String(pv.linkedFileId);
      byFile.set(key, [...(byFile.get(key) ?? []), pv]);
    }

    const candidates = files.map(f => {
      const resolvedFor = byFile.get(String(f._id)) ?? [];
      const resolved: Record<string, any> = { youtube: null, instagram: null, tiktok: null };
      for (const pv of resolvedFor) {
        resolved[pv.platform] = {
          platformId: pv.platformId, platformUrl: pv.platformUrl,
          title: pv.title, thumbnail: pv.thumbnail,
        };
      }
      const discardedSet = new Set(f.platforms_discarded ?? []);
      const discarded: Record<string, boolean> = {
        youtube: discardedSet.has('youtube'),
        instagram: discardedSet.has('instagram'),
        tiktok: discardedSet.has('tiktok'),
      };
      return {
        fileId:   String(f._id),
        fileName: f.file_name,
        fecha_creacion: f.fecha_creacion,
        resolved,
        discarded,
      };
    });

    res.json({ items: candidates, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/cross-match/resolve — confirma que un video de una plataforma
// específica corresponde a un archivo local puntual (ya sabido de antemano por
// tener las 3 badges). A diferencia de confirmCrossMatch, acá SÍ fija
// linkedFileId — es exactamente la misma acción que "Vincular con archivo local"
// (confirmLink), solo que el candidato puede venir de un fetch en vivo (IG/TikTok)
// que todavía no tiene un doc propio en Mongo, por eso hace upsert.
export const resolveCrossMatchSlot = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { fileId, platform, platformId, title, thumbnail, publishedAt, platformUrl, stats } = req.body ?? {};

    if (!fileId || !platform || !platformId) {
      res.status(400).json({ message: 'fileId, platform y platformId son requeridos.' });
      return;
    }
    if (!['youtube', 'instagram', 'tiktok'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' });
      return;
    }

    // Los nombres de campo de stats no son uniformes entre plataformas
    // (ver instagram.service.ts / tiktok.service.ts) — se normalizan acá para
    // que la vista de Estadísticas los pueda leer siempre igual.
    const s = stats ?? {};
    const views    = s.views    ?? 0;
    const likes    = s.likes    ?? s.like_count     ?? 0;
    const comments = s.comments ?? s.comments_count ?? 0;

    // Re-matchear (ej. un link que quedó apuntando a un video borrado/privado)
    // dejaba el doc VIEJO todavía linkeado a este archivo, con otro platformId
    // — group-stats terminaba con 2 registros "youtube" para el mismo archivo
    // compitiendo por el mismo slot, y cuál ganaba dependía del orden en que
    // Mongo los devolviera (el bug de "a veces sí, a veces no"). Se desvincula
    // cualquier otro doc de esta plataforma que ya apuntara acá antes de crear
    // el nuevo link, para que quede uno solo.
    await PlatformVideoModel.updateMany(
      { userId, platform, linkedFileId: new Types.ObjectId(fileId), platformId: { $ne: platformId } },
      { $set: { linkedFileId: null, matchStatus: 'sin_match' } },
    );

    await PlatformVideoModel.findOneAndUpdate(
      { userId, platform, platformId },
      {
        $set: {
          userId, platform, platformId,
          platformUrl:  platformUrl ?? '',
          title:        title ?? '',
          thumbnail:    thumbnail ?? '',
          publishedAt:  publishedAt ? new Date(publishedAt) : new Date(),
          linkedFileId: new Types.ObjectId(fileId),
          matchStatus:  'manual',
          views, likes, comments,
          lastSyncedAt: new Date(),
          // null explícito, no un `new Date()` -- `stats` viene del cliente
          // (puede ser lo que ya tenía cacheado desde que se listaron los
          // candidatos, no un fetch en vivo de ESTE instante), y encima este
          // mismo update puede estar re-matcheando a un platformId distinto
          // del anterior -- ni uno ni otro caso justifica heredar o inventar
          // un statsSyncedAt "fresco". Queda `stale` de entrada, se refresca
          // solo en el próximo getGroupStats/getFileStats real (Fase 5, ver
          // platform-video.model.ts).
          statsSyncedAt: null,
        },
      },
      { upsert: true }
    );

    // Igual que confirmLink: resolver un slot acá solo tocaba PlatformVideoModel
    // -- sin esto, un video recién matcheado desde Estadísticas/cross-match
    // podía tener el link ahí y en ningún otro lado (badge, Calendario, Nube).
    const linkedFile = await FileModel.findById(fileId).select('file_name').lean();
    if (linkedFile) {
      await applyPlatformPublish(userId, {
        platform, platformId, platformUrl,
        fileName: linkedFile.file_name,
        title, publishedAt: publishedAt ? new Date(publishedAt) : new Date(), matchStatus: 'manual',
      });
    }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// Cuánto tiempo se banca un valor guardado antes de pedirlo de nuevo en vivo —
// un video recién publicado se mueve rápido (vale la pena refrescar seguido),
// uno viejo ya está en plateau (refrescarlo todo el tiempo es gastar cuota de
// las APIs para no ver casi ningún cambio).
function statsCacheWindowMs(publishedAt?: Date | string | null): number {
  if (!publishedAt) return 60 * 60 * 1000; // sin fecha conocida → cada hora
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86_400_000;
  if (ageDays < 2) return 5 * 60 * 1000;   // < 2 días: cada 5 min
  return 60 * 60 * 1000;                    // 2+ días: cada hora
}

// Corrige EN MEMORIA (y best-effort en Mongo) cualquier platformId de TikTok
// que todavía sea el publish_id crudo de la operación de subir (formato
// "v_pub_..."), no el id numérico real del video. applyPlatformPublish ya
// intenta resolverlo una sola vez al momento de publicar, pero TikTok puede
// seguir procesando el video más allá de esa ventana (confirmado en
// producción: publish_id sin resolver horas después de publicar, con status
// PUBLISH_COMPLETE ya disponible) -- sin un reintento posterior, ese video
// quedaba con id inválido para siempre, sin stats/miniatura/link real. Se
// reintenta acá, en cada refresco de stats, así se autocorrige la primera vez
// que el id real ya esté disponible en la API de TikTok.
async function resolvePendingTikTokIds(userId: string, pvs: { platform: string; platformId: string; platformUrl?: string }[]): Promise<void> {
  const pending = pvs.filter(pv => pv.platform === 'tiktok' && !/^\d+$/.test(pv.platformId));
  if (pending.length === 0) return;
  await Promise.all(pending.map(async (pv) => {
    try {
      const resolved = await resolveTikTokVideoId(userId, pv.platformId);
      if (!resolved || resolved === pv.platformId) return;
      const oldId = pv.platformId;
      pv.platformId = resolved; // corrige en memoria para que este mismo request ya pida stats con el id bueno
      // Bug real confirmado 2026-08-15: acá solo se corregía platformId, nunca
      // platformUrl -- el video quedaba con el id real (stats/thumbnail andando)
      // pero el link seguía armado con el publish_id crudo del momento de
      // publicar (video/v_pub_file~...) para siempre, porque ni getFileStats
      // ni getGroupStats tocan platformUrl en su refresco en vivo (solo
      // views/likes/comments/thumbnail). Se reconstruye acá con el mismo
      // patrón que tiktok-upload.controller.ts usa al publicar.
      let resolvedUrl: string | undefined;
      try {
        const token = await getValidTikTokToken(userId);
        resolvedUrl = `https://www.tiktok.com/@${token.open_id}/video/${resolved}`;
        pv.platformUrl = resolvedUrl;
      } catch { /* sin token válido -- se sigue con solo el id corregido, como antes */ }
      await PlatformVideoModel.updateOne(
        { userId, platform: 'tiktok', platformId: oldId },
        { $set: { platformId: resolved, ...(resolvedUrl ? { platformUrl: resolvedUrl } : {}) } },
      );
      // UploadHistoryModel es una colección aparte (el log que lee Historial
      // en mobile/web remoto) -- sin esto, se queda con el publish_id crudo
      // para siempre aunque PlatformVideoModel ya se haya corregido, y
      // clientes SIN merge local (mobile/web, a diferencia de desktop que
      // dedupea por fileName como respaldo) terminan mostrando un link roto
      // que nunca se arregla solo.
      await UploadHistoryModel.updateOne(
        { userId, platform: 'tiktok', platformId: oldId },
        { $set: { platformId: resolved, ...(resolvedUrl ? { platformUrl: resolvedUrl } : {}) } },
      ).catch(() => { /* duplicado (ya existe un doc con ese id real) -- no es crítico, Historial ya lo dedupea por fileName del lado desktop */ });
    } catch { /* duplicado (ya existe un doc con ese id real) o falla de red -- se reintenta en el próximo refresh */ }
  }));
}

// Dado los PlatformVideo (posiblemente más de un documento por plataforma,
// ver applyPlatformPublish) linkeados a UN archivo, arma el objeto `platforms`
// quedándose con el mejor documento por plataforma y qué platformId de cada
// plataforma venció su ventana de cache y hay que refrescar en vivo.
// Compartido por getGroupStats (top-N completos) y getFileStats (un archivo
// puntual, sin exigir que esté en las 3 redes).
function buildFilePlatforms(pvs: {
  platform: string; platformId: string; platformUrl: string; title: string; thumbnail: string;
  views: number; likes: number; comments: number; publishedAt: Date; lastSyncedAt: Date;
  statsSyncedAt?: Date | null;
}[]) {
  // Un mismo video de Instagram o TikTok puede tener más de un documento
  // (shortcode/publish_id sin resolver de un intento viejo vs. el id numérico
  // real -- ver applyPlatformPublish y resolvePendingTikTokIds). El sin
  // resolver nunca tiene stats reales (Graph API no acepta shortcodes; TikTok
  // rechaza ids no numéricos). Ante un duplicado por plataforma se prefiere el
  // platformId numérico y, si empatan, el sincronizado más reciente -- si no,
  // cuál "gana" quedaba a merced del orden de Mongo (bug real confirmado con
  // un video de TikTok que quedó mostrando 0 vistas para siempre porque el
  // doc viejo sin resolver se sincronizó después que el bueno).
  const bestByPlatform = new Map<string, (typeof pvs)[number]>();
  for (const pv of pvs) {
    const current = bestByPlatform.get(pv.platform);
    if (!current) { bestByPlatform.set(pv.platform, pv); continue; }
    if (pv.platform === 'instagram' || pv.platform === 'tiktok') {
      const currentNumeric = /^\d+$/.test(current.platformId);
      const candidateNumeric = /^\d+$/.test(pv.platformId);
      if (candidateNumeric && !currentNumeric) { bestByPlatform.set(pv.platform, pv); continue; }
      if (!candidateNumeric && currentNumeric) continue;
    }
    const currentSynced = current.lastSyncedAt ? new Date(current.lastSyncedAt).getTime() : 0;
    const candidateSynced = pv.lastSyncedAt ? new Date(pv.lastSyncedAt).getTime() : 0;
    if (candidateSynced > currentSynced) bestByPlatform.set(pv.platform, pv);
  }

  const platforms: Record<string, any> = {};
  const stale: Record<'youtube' | 'instagram' | 'tiktok', string | null> = { youtube: null, instagram: null, tiktok: null };
  for (const pv of bestByPlatform.values()) {
    platforms[pv.platform] = {
      platformId: pv.platformId, platformUrl: pv.platformUrl, title: pv.title, thumbnail: pv.thumbnail,
      views: pv.views ?? 0, likes: pv.likes ?? 0, comments: pv.comments ?? 0,
    };
    // statsSyncedAt, no lastSyncedAt -- ver comentario en platform-video.model.ts
    // (Fase 5, plan de invalidación instantánea 2026-08-31). null (match recién
    // creado, nunca se pidieron métricas reales) siempre cuenta como vencido,
    // sin esperar la ventana de caché.
    const statsSynced = pv.statsSyncedAt ? new Date(pv.statsSyncedAt).getTime() : 0;
    if (Date.now() - statsSynced > statsCacheWindowMs(pv.publishedAt)) {
      stale[pv.platform as 'youtube' | 'instagram' | 'tiktok'] = pv.platformId;
    }
  }
  return { platforms, stale };
}

// GET /api/sync/group-stats?limit=5 — para la vista de Estadísticas: los últimos
// N videos que YA están matcheados en las 3 plataformas, con las stats de cada
// una para compararlas lado a lado. Es la misma vista para modo simple y
// avanzado (no depende de workflow_mode) — el matching es siempre por archivo.
export const getGroupStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const limit  = Math.min(parseInt(req.query.limit as string) || 5, 20);
    const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
    if (platform && !['youtube', 'instagram', 'tiktok'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' }); return;
    }

    let files: { _id: any; file_name: string; fecha_creacion?: Date | null }[];
    let linked: any[];

    if (platform) {
      // Arranca DESDE PlatformVideoModel, no desde FileModel. Antes se
      // enumeraba FileModel primero y recién después se buscaba qué
      // PlatformVideoModel estaba linkeado a esos ids -- un mismo video
      // puede tener MÁS de un documento en FileModel (duplicados que deja
      // resolveOrCreateFile por sus distintos caminos de resolución: por
      // content_id, por file_name exacto, por regex case-insensitive, por
      // nombre de Biblioteca remota, o el upsert de última instancia). Si el
      // doc que aparecía en la enumeración NO era el mismo al que apunta
      // PlatformVideoModel.linkedFileId, el video quedaba afuera de
      // Estadísticas para esa plataforma aunque sí tuviera el link real y
      // funcionara bien vía /api/sync/file-stats (que sí resuelve por
      // linkedFileId directo). Bug real confirmado: "final - denuvo1.mp4"
      // nunca aparecía en la pestaña TikTok pese a tener vistas reales.
      const rawLinked = await PlatformVideoModel.find({
        userId, platform: platform as 'youtube' | 'instagram' | 'tiktok', platformId: { $ne: '' }, linkedFileId: { $ne: null },
      })
        .select('linkedFileId platform platformId platformUrl title thumbnail views likes comments publishedAt lastSyncedAt statsSyncedAt')
        .sort({ publishedAt: -1 })
        .limit(limit * 4)
        .lean();

      // Mismo criterio que ya usa buildFilePlatforms para Instagram/TikTok:
      // si el mismo archivo tiene más de un documento para esta plataforma
      // (reintento de subida, link corregido a mano), se prefiere el
      // platformId numérico (resuelto) por sobre uno crudo sin resolver.
      const isResolved = (id: string) => /^\d+$/.test(id);
      const byLinkedFile = new Map<string, typeof rawLinked[number]>();
      for (const pv of rawLinked) {
        const key = String(pv.linkedFileId);
        const current = byLinkedFile.get(key);
        if (!current) { byLinkedFile.set(key, pv); continue; }
        if (isResolved(pv.platformId) && !isResolved(current.platformId)) byLinkedFile.set(key, pv);
      }
      linked = [...byLinkedFile.values()].sort(
        (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      );
      await resolvePendingTikTokIds(userId, linked);

      // El orden de `files` decide qué `limit` entran más abajo -- se arma
      // en el MISMO orden que `linked` (ya deduplicado y ordenado por fecha
      // real de publicación en esta plataforma), no en el orden que devuelva
      // Mongo para un $in (no lo garantiza).
      const orderedFileIds = linked.map(pv => String(pv.linkedFileId));
      const filesById = new Map(
        (await FileModel.find({ userId, _id: { $in: orderedFileIds }, status: { $ne: 'ELIMINADO_DISCO' } })
          .select('file_name fecha_creacion')
          .lean())
          .map(f => [String(f._id), f]),
      );
      files = orderedFileIds
        .map(id => filesById.get(id))
        .filter((f): f is NonNullable<typeof f> => !!f);
    } else {
      // El .sort({fecha_creacion: -1}) de acá es solo el orden de arranque --
      // se reemplaza más abajo (ver BUG-2026-08-18-01) por el orden real una
      // vez que se sabe el publishedAt de las 3 plataformas linkeadas.
      files = await FileModel.find({
        userId,
        platforms: { $all: ['youtube', 'instagram', 'tiktok'] },
        status: { $ne: 'ELIMINADO_DISCO' },
      })
        .sort({ fecha_creacion: -1 })
        .select('file_name fecha_creacion')
        .lean();
      const fileIds = files.map(f => f._id);
      // La vista compara solo las 3 redes con stats propias — los registros de
      // 'facebook' (crossposting) quedan afuera para no inflar el conteo de "3
      // plataformas vinculadas" ni pedir stats que Facebook no expone acá.
      linked = await PlatformVideoModel.find({
        userId, linkedFileId: { $in: fileIds }, platform: { $in: ['youtube', 'instagram', 'tiktok'] },
      })
        .select('linkedFileId platform platformId platformUrl title thumbnail views likes comments publishedAt lastSyncedAt statsSyncedAt')
        .lean();
      await resolvePendingTikTokIds(userId, linked);
    }

    const byFile = new Map<string, typeof linked>();
    for (const pv of linked) {
      const key = String(pv.linkedFileId);
      byFile.set(key, [...(byFile.get(key) ?? []), pv]);
    }

    // BUG-2026-08-18-01: "cuándo terminó de completarse el match" es el
    // publishedAt más reciente entre las 3 plataformas linkeadas -- no
    // f.fecha_creacion (mtime del archivo en disco, ver watcher.ts, sin
    // relación con publicación). Compartido por el reorder de `files` de
    // abajo y por el campo `fecha_creacion` de cada item más adelante.
    const latestPublishedAt = (pvs: typeof linked): Date | null =>
      pvs.reduce<Date | null>((latest, pv) => {
        if (!pv.publishedAt) return latest;
        const d = new Date(pv.publishedAt);
        return !latest || d > latest ? d : latest;
      }, null);

    // Solo aplica a la pestaña "Comparadas" (sin `platform`) -- la rama CON
    // `platform` ya ordena por publishedAt real más arriba, no hay nada que
    // corregir ahí.
    if (!platform) {
      files = [...files].sort((a, b) => {
        const aDate = latestPublishedAt(byFile.get(String(a._id)) ?? []);
        const bDate = latestPublishedAt(byFile.get(String(b._id)) ?? []);
        return (bDate?.getTime() ?? 0) - (aDate?.getTime() ?? 0);
      });
    }

    // Biblioteca remota es otra colección (storage en la nube), sin id en común
    // con FileModel — el único cruce posible hoy es por fileName. Ya viene
    // scopeado por userId, así que no hay ambigüedad ENTRE cuentas. Pero DENTRO
    // de la misma cuenta el nombre no es único (ej. nombres genéricos de cámara
    // repetidos): si el mismo fileName aparece más de una vez en el catálogo o
    // en Biblioteca remota, no hay forma de saber cuál es cuál — se deja sin
    // asignar (null) antes que arriesgar mostrar la miniatura equivocada.
    const fileNameCounts = new Map<string, number>();
    for (const f of files) {
      if (!f.file_name) continue;
      fileNameCounts.set(f.file_name, (fileNameCounts.get(f.file_name) ?? 0) + 1);
    }
    const fileNames = [...fileNameCounts.keys()];
    const remoteVideos = fileNames.length
      ? await RemoteLibraryVideoModel.find({ userId, fileName: { $in: fileNames } })
          .select('fileName thumbnailStoredFileName')
          .lean()
      : [];
    const remoteByFileName = new Map<string, { id: string; thumbnailStoredFileName: string | null }>();
    const remoteNameAmbiguous = new Set<string>();
    for (const rv of remoteVideos) {
      if (remoteByFileName.has(rv.fileName) || remoteNameAmbiguous.has(rv.fileName)) {
        remoteByFileName.delete(rv.fileName);
        remoteNameAmbiguous.add(rv.fileName);
      } else {
        remoteByFileName.set(rv.fileName, { id: String(rv._id), thumbnailStoredFileName: rv.thumbnailStoredFileName ?? null });
      }
    }

    const items: any[] = [];
    // Solo se piden en vivo los platformId que ya vencieron su ventana de
    // cache — el resto se sirve directo de lo guardado en Mongo.
    const toRefresh: Record<'youtube' | 'instagram' | 'tiktok', string[]> = { youtube: [], instagram: [], tiktok: [] };

    for (const f of files) {
      if (items.length >= limit) break;
      const pvs = byFile.get(String(f._id)) ?? [];
      // files.platforms también puede contener badges puestos manualmente sin
      // URL. Esos videos no tienen una identidad consultable ni métricas reales;
      // solo entran cuando las tres plataformas tienen PlatformVideoModel.
      const complete = platform
        ? pvs.some(pv => pv.platform === platform && !!pv.platformId)
        : ['youtube', 'instagram', 'tiktok'].every(name => pvs.some(pv => pv.platform === name && !!pv.platformId));
      if (!complete) continue;

      const { platforms, stale } = buildFilePlatforms(pvs);
      if (platform) {
        for (const name of ['youtube', 'instagram', 'tiktok']) {
          if (name !== platform) {
            delete platforms[name];
            delete stale[name as 'youtube' | 'instagram' | 'tiktok'];
          }
        }
      }
      if (stale.youtube) toRefresh.youtube.push(stale.youtube);
      if (stale.instagram) toRefresh.instagram.push(stale.instagram);
      if (stale.tiktok) toRefresh.tiktok.push(stale.tiktok);
      // Si el nombre se repite entre los propios archivos del usuario, tampoco
      // se puede saber a cuál de ellos corresponde el match — mismo criterio
      // conservador que para duplicados del lado de Biblioteca remota.
      const nameIsUnique = fileNameCounts.get(f.file_name) === 1;
      const remoteMatch = nameIsUnique ? remoteByFileName.get(f.file_name) : undefined;
      items.push({
        fileId: String(f._id),
        fileName: f.file_name,
        remoteLibraryVideoId: remoteMatch?.id ?? null,
        thumbnailStoredFileName: remoteMatch?.thumbnailStoredFileName ?? null,
        fecha_creacion: platform
          ? pvs.filter(pv => pv.platform === platform).sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())[0]?.publishedAt ?? f.fecha_creacion
          // BUG-2026-08-18-01: antes era f.fecha_creacion (mtime del archivo
          // en disco) -- el campo que el frontend/mobile muestra para esta
          // pestaña pasa a ser la fecha real de match, igual que el orden.
          : latestPublishedAt(pvs) ?? f.fecha_creacion,
        platforms,
      });
    }

    // Refresco en vivo — acotado por la ventana de cache de arriba y, en el
    // peor caso (todo vencido), a como mucho `limit` videos × 3 plataformas.
    const [ytStats, igStats, tkStats] = await Promise.all([
      getYoutubeVideoStats(toRefresh.youtube).catch(() => ({} as Record<string, any>)),
      getMediaStats(userId, toRefresh.instagram).catch(() => ({} as Record<string, any>)),
      getTiktokVideoStats(userId, toRefresh.tiktok).catch(() => ({} as Record<string, any>)),
    ]);

    const bulkOps: any[] = [];
    for (const item of items) {
      for (const [platform, fresh] of [['youtube', ytStats], ['instagram', igStats], ['tiktok', tkStats]] as const) {
        const slot = item.platforms[platform];
        const update = slot && fresh[slot.platformId];
        if (!update) continue;
        // Object.assign pisaría un thumbnail ya guardado con `undefined` si
        // esta vez la API no lo trajo (ej. YouTube sin snippet.thumbnails) --
        // se conserva el anterior en ese caso en vez de perderlo.
        const previousThumbnail = slot.thumbnail;
        Object.assign(slot, update);
        if (!slot.thumbnail) slot.thumbnail = previousThumbnail;
        bulkOps.push({
          updateOne: {
            filter: { userId, platform, platformId: slot.platformId },
            update: { $set: {
              views: update.views ?? 0, likes: update.likes ?? 0, comments: update.comments ?? 0,
              lastSyncedAt: new Date(),
              // Esto SÍ es un fetch real a la API de la plataforma (arriba,
              // Promise.all de getYoutubeVideoStats/getMediaStats/
              // getTiktokVideoStats) -- acá corresponde marcar fresco de
              // verdad (Fase 5, ver platform-video.model.ts).
              statsSyncedAt: new Date(),
              // Ninguno de los uploaders (applyPlatformPublish) tiene de dónde
              // sacar una miniatura al momento de publicar -- se completa acá,
              // aprovechando el mismo refresco en vivo que ya pide stats.
              ...(update.thumbnail ? { thumbnail: update.thumbnail } : {}),
            } },
          },
        });
      }
    }
    if (bulkOps.length > 0) PlatformVideoModel.bulkWrite(bulkOps).catch(() => {});

    res.json({ items });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/sync/file-stats?fileId=&fileName= — stats en vivo de UN archivo
// puntual, sin exigir que ya esté publicado en las 3 plataformas (a diferencia
// de getGroupStats). La usa el Dashboard para el card de "último video
// publicado": ese video puede todavía no estar cross-posteado a las 3 redes,
// así que no puede depender de estar en el top-N "completo" de Estadísticas.
// Acepta fileId (el _id de Mongo que expone group-stats) o fileName -- en modo
// escritorio, el historial de subidas viene de SQLite local y su linkedFileId
// es un id local sin relación con Mongo, así que fileName es el único cruce
// posible ahí.
export const getFileStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const fileId = typeof req.query.fileId === 'string' ? req.query.fileId : undefined;
    const fileName = typeof req.query.fileName === 'string' ? req.query.fileName : undefined;
    if (!fileId && !fileName) { res.status(400).json({ message: 'fileId o fileName requerido.' }); return; }

    const file = fileId && Types.ObjectId.isValid(fileId)
      ? await FileModel.findOne({ _id: fileId, userId }).select('file_name content_id fecha_creacion platforms_discarded').lean()
      : fileName
        ? await FileModel.findOne({ userId, file_name: fileName }).select('file_name content_id fecha_creacion platforms_discarded').lean()
        : null;
    if (!file) { res.status(404).json({ message: 'No encontrado.' }); return; }

    const pvs = await PlatformVideoModel.find({
      userId, linkedFileId: file._id, platform: { $in: ['youtube', 'instagram', 'tiktok'] },
    })
      .select('platform platformId platformUrl title thumbnail views likes comments publishedAt lastSyncedAt statsSyncedAt')
      .lean();
    await resolvePendingTikTokIds(userId, pvs);

    // La miniatura generada al subir desde Electron vive en Biblioteca remota,
    // no necesariamente en PlatformVideo.thumbnail (la API de la plataforma
    // puede tardar en devolverla). El dashboard móvil necesita estos campos
    // cuando el video recién publicado todavía no entró en group-stats.
    //
    // BUG-2026-09-06-05 (ver docs/bug-reports.md): matcheaba solo por
    // `fileName` -- un archivo cuyo nombre real en disco difiere de la copia
    // en Nube ni siquiera por un renombre real, sino por una diferencia
    // trivial (ej. doble espacio, mayúsculas) nunca encontraba su miniatura,
    // aunque fuera el MISMO video (mismo content_id). Ahora matchea por
    // content_id primero (estable, sobrevive cualquier diferencia de nombre)
    // y cae a fileName solo si el archivo no tiene content_id todavía.
    const remoteMatches = await RemoteLibraryVideoModel.find(
      (file as any).content_id ? { userId, contentId: (file as any).content_id } : { userId, fileName: file.file_name },
    ).select('_id thumbnailStoredFileName').lean();
    const remoteMatch = remoteMatches.length === 1 ? remoteMatches[0] : null;

    const { platforms, stale } = buildFilePlatforms(pvs);

    const [ytStats, igStats, tkStats] = await Promise.all([
      getYoutubeVideoStats(stale.youtube ? [stale.youtube] : []).catch(() => ({} as Record<string, any>)),
      getMediaStats(userId, stale.instagram ? [stale.instagram] : []).catch(() => ({} as Record<string, any>)),
      getTiktokVideoStats(userId, stale.tiktok ? [stale.tiktok] : []).catch(() => ({} as Record<string, any>)),
    ]);

    const bulkOps: any[] = [];
    for (const [platform, fresh] of [['youtube', ytStats], ['instagram', igStats], ['tiktok', tkStats]] as const) {
      const slot = platforms[platform];
      const update = slot && fresh[slot.platformId];
      if (!update) continue;
      const previousThumbnail = slot.thumbnail;
      Object.assign(slot, update);
      if (!slot.thumbnail) slot.thumbnail = previousThumbnail;
      bulkOps.push({
        updateOne: {
          filter: { userId, platform, platformId: slot.platformId },
          update: { $set: {
            views: update.views ?? 0, likes: update.likes ?? 0, comments: update.comments ?? 0,
            lastSyncedAt: new Date(),
            // Fetch real a la API de la plataforma -- ver mismo comentario en
            // getGroupStats (Fase 5, platform-video.model.ts).
            statsSyncedAt: new Date(),
            // Ninguno de los uploaders (applyPlatformPublish) tiene de dónde
            // sacar una miniatura al momento de publicar -- se completa acá,
            // aprovechando el mismo refresco en vivo que ya pide stats.
            ...(update.thumbnail ? { thumbnail: update.thumbnail } : {}),
          } },
        },
      });
    }
    if (bulkOps.length > 0) PlatformVideoModel.bulkWrite(bulkOps).catch(() => {});

    res.json({
      fileId: String(file._id),
      fileName: file.file_name,
      fecha_creacion: file.fecha_creacion,
      remoteLibraryVideoId: remoteMatch ? String(remoteMatch._id) : null,
      thumbnailStoredFileName: remoteMatch?.thumbnailStoredFileName ?? null,
      platforms,
      // Bug real reportado 2026-09-01: el Dashboard (Electron/iOS) mostraba
      // "Pendiente de datos" para una plataforma que el usuario había
      // DESCARTADO a propósito -- el widget solo distinguía "tengo slot" vs
      // "no tengo slot", sin poder saber si "no tengo slot" era pendiente
      // real o una decisión ya tomada. Se agrega acá (no en getGroupStats,
      // que no lo necesitaba para este reporte puntual) para que el cliente
      // pueda mostrar "Descartado" en vez de "Pendiente de datos".
      platforms_discarded: file.platforms_discarded ?? [],
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/stats-by-ids — stats en vivo para un set de platformId sueltos,
// sin pasar por PlatformVideoModel/cross-match. Lo usa local-backend para armar
// Estadísticas de instalaciones que solo tienen el catálogo en SQLite local (no
// respaldado en la nube): arma los ids desde platform_videos local y pide acá
// las stats reales, usando igual los tokens OAuth que viven en esta central.
export const getStatsByIds = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const body = req.body ?? {};
    const clamp = (arr: unknown): string[] => (Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []).slice(0, 60);
    const youtube   = clamp(body.youtube);
    const instagram = clamp(body.instagram);
    const tiktok    = clamp(body.tiktok);

    // TikTok puede devolver inicialmente un publish_id (v_pub_...) en vez del
    // id numérico del video. Resolverlo acá permite a Electron pedir métricas
    // de su historial local sin tener que esperar otro sync completo.
    const resolvedTikTok = await Promise.all(tiktok.map(async requestedId => ({
      requestedId,
      resolvedId: await resolveTikTokVideoId(userId, requestedId).catch(() => null) ?? requestedId,
    })));

    const [ytStats, igStats, rawTkStats] = await Promise.all([
      getYoutubeVideoStats(youtube).catch(() => ({} as Record<string, any>)),
      getMediaStats(userId, instagram).catch(() => ({} as Record<string, any>)),
      getTiktokVideoStats(userId, [...new Set(resolvedTikTok.map(entry => entry.resolvedId))]).catch(() => ({} as Record<string, any>)),
    ]);
    const tkStats = Object.fromEntries(resolvedTikTok.flatMap(({ requestedId, resolvedId }) => {
      const stats = rawTkStats[resolvedId];
      return stats ? [[requestedId, stats]] : [];
    }));

    res.json({ youtube: ytStats, instagram: igStats, tiktok: tkStats });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

const DEFAULT_INTERVAL_DAYS: Record<string, number> = { youtube: 4, instagram: 3, tiktok: 3 };

// Calcula "último publicado" a partir de PlatformVideoModel real (lo que suben
// syncYouTubeChannel, una subida real, o recordUploadEvent) -- independiente
// de que exista o no un override guardado en platform_config.
async function computeLastPublishedDynamic(
  userId: string,
  platform: string,
): Promise<{ lastPublishedTitle: string; lastPublishedDate: string; intervalDays: number } | null> {
  // Sin exigir linkedFileId -- el auto-sync de YouTube (syncYouTubeChannel)
  // trae los videos reales del canal ANTES de que alguien los cruce a mano
  // con su archivo local, así que los más recientes suelen llegar sin
  // linkedFileId todavía. Antes este filtro los excluía del todo, dejando
  // "último publicado" pegado en el último que SÍ estaba cruzado (días
  // atrás) en vez de en la publicación real más reciente.
  const videos = await PlatformVideoModel.find({ userId, platform: platform as SyncPlatform })
    .sort({ publishedAt: -1 })
    .limit(7)
    .lean();
  if (videos.length === 0) return null;

  const diffs: number[] = [];
  for (let i = 0; i < Math.min(6, videos.length - 1); i++) {
    const diff = Math.round(
      (new Date(videos[i].publishedAt).getTime() - new Date(videos[i + 1].publishedAt).getTime())
      / (1000 * 60 * 60 * 24)
    );
    diffs.push(diff);
  }
  const intervalDays = diffs.length
    ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length)
    : DEFAULT_INTERVAL_DAYS[platform];

  const linkedFile = videos[0].linkedFileId
    ? await FileModel.findById(videos[0].linkedFileId).select('file_name').lean()
    : null;
  return {
    lastPublishedTitle: linkedFile?.file_name ?? videos[0].title,
    lastPublishedDate:  new Date(videos[0].publishedAt).toISOString().slice(0, 10),
    intervalDays,
  };
}

// GET /api/sync/calendar-config — configuración real del calendario por plataforma
export const getCalendarConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const db = (await import('mongoose')).default.connection.db!;
    const userId = req.user!.id;   // calendario por cuenta (no compartido entre usuarios)

    // platform_config tiene overrides que solo avanzan por caminos puntuales
    // (subir desde el escritorio, el botón "Fijar", o recordUploadEvent tras
    // publicar desde el celular) -- CUALQUIER otra vía que marque un video
    // como publicado (el auto-sync de YouTube, publicar directo desde
    // Biblioteca remota, vincular a mano en Sincronizar) nunca los toca, y el
    // override se queda pegado mostrando un "último publicado" viejo aunque
    // haya algo más reciente de verdad. Por eso NINGUNA plataforma confía
    // ciegamente en el override: siempre se calcula también la versión real
    // (PlatformVideoModel, la fuente que sí actualizan todos esos caminos) y
    // se usa la que tenga la fecha más reciente de las dos.
    const stored = await db.collection('platform_config')
      .find({ userId, platform: { $in: ['tiktok', 'instagram', 'youtube'] } })
      .toArray();

    const storedMap = new Map(stored.map(c => [c.platform as string, c]));

    const allConfigs = await Promise.all(['youtube', 'tiktok', 'instagram'].map(async (platform) => {
      const override = storedMap.get(platform);
      const dynamic = await computeLastPublishedDynamic(userId, platform);

      const overrideDate = override?.lastPublishedDate ? new Date(override.lastPublishedDate).getTime() : 0;
      const dynamicDate = dynamic?.lastPublishedDate ? new Date(dynamic.lastPublishedDate).getTime() : 0;
      // `lastPublishedDate` solo guarda el día, así que un empate (mismo día)
      // es ambiguo por fecha -- pero la fuente dinámica (PlatformVideoModel)
      // SIEMPRE refleja la publicación real más reciente, la actualice quien
      // la actualice, así que en el empate gana ella. El intervalDays que el
      // usuario ajustó a mano en el override no se pierde: se conserva aparte.
      const useDynamic = dynamic && dynamicDate >= overrideDate;

      const base = useDynamic
        ? { ...dynamic!, intervalDays: override?.intervalDays ?? dynamic!.intervalDays }
        : override
          ? { lastPublishedTitle: override.lastPublishedTitle, lastPublishedDate: override.lastPublishedDate, intervalDays: override.intervalDays ?? dynamic?.intervalDays ?? DEFAULT_INTERVAL_DAYS[platform] }
          : dynamic ?? { lastPublishedTitle: '', lastPublishedDate: '', intervalDays: DEFAULT_INTERVAL_DAYS[platform] };

      return {
        platform,
        ...base,
        lastVideoId: override?.lastVideoId ?? null,
        nextVideoId: override?.nextVideoId ?? null,
        nextRemoteLibraryVideoId: override?.nextRemoteLibraryVideoId ?? null,
      };
    }));

    // Enriquece con datos del nextVideo para cada plataforma. El puntero guardado
    // (nextVideoId) solo avanza vía "Subir" o el botón "Fijar" del calendario —
    // marcar la plataforma resuelta por otro camino (toggle en Videos, "Editar
    // links") no lo toca. Si el archivo al que apunta ya está resuelto para ESA
    // plataforma (publicado o descartado), el puntero quedó obsoleto: se
    // descarta y se recalcula el verdadero próximo (el más reciente sin
    // resolver ahí), igual que hace fileRepo.findNextUnpublished en local.
    const enriched = await Promise.all(allConfigs.map(async (cfg) => {
      const platform = cfg.platform;
      let file: any = null;
      let resolvedId: string | null = null; // a qué archivo apuntaba el puntero guardado, antes de chequear si quedó obsoleto

      if (cfg.nextVideoId) {
        try {
          const mongoose = (await import('mongoose')).default;
          try {
            file = await FileModel.findById(new mongoose.Types.ObjectId(String(cfg.nextVideoId)))
              .select('file_name content_id duracion_segundos platforms platforms_discarded status').lean();
          } catch { /* nextVideoId no es un ObjectId válido — buscar por file_name */ }
          if (!file) {
            file = await FileModel.findOne({ file_name: String(cfg.nextVideoId), userId })
              .select('file_name content_id duracion_segundos platforms platforms_discarded status').lean();
          }
          if (file) {
            resolvedId = String((file as any)._id);
            // Obsoleto también si el archivo ya se borró del disco -- sin este
            // chequeo el Calendario se queda apuntando indefinidamente a un
            // video eliminado (nunca se publicó/descartó ahí, así que las
            // otras dos condiciones nunca se cumplen).
            if (
              (file.platforms ?? []).includes(platform) ||
              (file.platforms_discarded ?? []).includes(platform) ||
              (file as any).status === 'ELIMINADO_DISCO'
            ) {
              file = null; // obsoleto — cae al recálculo de abajo
            }
          }
        } catch { file = null; }
      }

      if (!file) {
        // ASC (el más VIEJO pendiente primero) -- con DESC un video recién
        // grabado se colaba delante de meses de backlog real (ya publicado en
        // otra plataforma, todavía esperando esta). Mismo fix que
        // fileRepo.findNextUnpublished en local-backend.
        file = await FileModel.findOne({
          userId,
          status: { $ne: 'ELIMINADO_DISCO' },
          content_status: { $ne: 'descartado' },
          platforms: { $ne: platform },
          platforms_discarded: { $ne: platform },
        }).sort({ fecha_creacion: 1, _id: 1 }).select('file_name content_id duracion_segundos').lean();
      }

      // Esta autocorrección antes solo vivía en memoria (se devolvía bien en
      // la respuesta pero platform_config quedaba con el puntero viejo para
      // siempre). Sin persistirla, ensurePreloadForNextVideos (desktop) sigue
      // viendo el nextRemoteLibraryVideoId huérfano de la vez anterior y nunca
      // vuelve a precargar el archivo realmente próximo -- mismo bug que en
      // syncCalendarAfterPublish, este es el otro camino por el que "próximo"
      // podía cambiar sin invalidar la precarga.
      const finalId = file ? String((file as any)._id) : null;
      if (finalId !== resolvedId) {
        const mongooseMod = (await import('mongoose')).default;
        mongooseMod.connection.db!.collection('platform_config').updateOne(
          { userId, platform },
          { $set: { nextVideoId: file ? (file as any).file_name : null, nextRemoteLibraryVideoId: null } },
        ).catch(() => {});
      }

      if (!file) return { ...cfg, nextVideoId: null, nextVideo: null };
      const dur = (file as any).duracion_segundos as number | undefined;
      const duration = dur
        ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`
        : '';
      // Para la miniatura del Calendario en mobile (iOS/Android): "próximo"
      // suele ser un archivo que solo existe en el catálogo de OTRO
      // dispositivo (la PC que lo grabó), así que el cliente no siempre tiene
      // una copia local de la que sacar el frame -- mismo cruce que ya usa
      // getGroupStats/getFileStats para Estadísticas (Biblioteca remota no
      // comparte id con FileModel).
      //
      // BUG-2026-09-06-05 (ver docs/bug-reports.md): matcheaba solo por
      // `fileName` -- confirmado en vivo en producción con "final - sufre.mp4":
      // el archivo real en disco es "final  - sufre.mp4" (doble espacio),
      // mientras que la copia en Nube quedó como "final - sufre.mp4" (uno
      // solo) -- mismo content_id, mismo video, pero el cruce por texto
      // nunca matcheaba, así que el Calendario mostraba el "próximo" de
      // YouTube sin miniatura. De paso explica por qué iOS tampoco mostraba
      // la etiqueta "Próximo" en su lista de Videos: el título que manda
      // este endpoint (`file.file_name`, con el doble espacio) tampoco
      // coincidía con el nombre de la copia local en el celular (bajada de
      // Nube, un solo espacio) -- mismo síntoma, misma causa. Ahora matchea
      // por content_id primero (estable, sobrevive cualquier diferencia de
      // nombre) y cae a fileName solo si el archivo no tiene content_id
      // todavía. Ambigüedad de nombre repetido (fallback por fileName sin
      // content_id): se deja sin asignar antes que mostrar la miniatura
      // equivocada.
      const remoteMatches = await RemoteLibraryVideoModel.find(
        (file as any).content_id
          ? { userId, contentId: (file as any).content_id }
          : { userId, fileName: (file as any).file_name },
      )
        .select('thumbnailStoredFileName')
        .limit(2)
        .lean();
      const remoteMatch = remoteMatches.length === 1 ? remoteMatches[0] : null;
      return {
        ...cfg,
        nextVideoId: String(file._id),
        nextVideo: {
          fileId: String(file._id),
          contentId: (file as any).content_id ?? null,
          title: (file as any).file_name,
          duration,
          remoteLibraryVideoId: remoteMatch ? String(remoteMatch._id) : null,
          thumbnailStoredFileName: remoteMatch?.thumbnailStoredFileName ?? null,
        },
      };
    }));

    res.json(enriched);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/sync/calendar-config/:platform — fija el último video publicado en cualquier plataforma
export const updateCalendarConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { platform } = req.params;
    const { lastPublishedDate, lastPublishedTitle, intervalDays, lastVideoId, nextVideoId, nextRemoteLibraryVideoId } = req.body;
    if (!['tiktok', 'instagram', 'youtube'].includes(platform)) {
      res.status(400).json({ message: 'Plataforma no válida' });
      return;
    }
    const fields: Record<string, unknown> = {};
    if (lastPublishedDate  !== undefined) fields.lastPublishedDate  = lastPublishedDate;
    if (lastPublishedTitle !== undefined) fields.lastPublishedTitle = lastPublishedTitle;
    if (intervalDays       !== undefined) fields.intervalDays       = intervalDays;
    if (lastVideoId        !== undefined) fields.lastVideoId        = lastVideoId;
    if (nextVideoId        !== undefined) fields.nextVideoId        = nextVideoId;
    // Id real de RemoteLibraryVideoModel para "el próximo" -- lo manda el
    // cliente (local-backend, ver calendar-sync.service.ts) DESPUÉS de
    // confirmar/subir el video a Biblioteca remota. Reemplaza el cruce por
    // fileName (ambiguo si hay nombres repetidos) como fuente de verdad para
    // el almacenamiento dinámico (ver remote-library-retention.service.ts).
    if (nextRemoteLibraryVideoId !== undefined) fields.nextRemoteLibraryVideoId = nextRemoteLibraryVideoId;

    const userId = req.user!.id;
    fields.userId = userId;
    const db = (await import('mongoose')).default.connection.db!;
    await db.collection('platform_config').updateOne(
      { userId, platform },
      { $set: fields },
      { upsert: true }
    );

    // Fase 5 (auditoría): este endpoint también lo pisan actualizaciones
    // AUTOMÁTICAS después de cada publicación (lastPublishedDate/Title,
    // lastVideoId) y al "pinnear" el próximo video (nextVideoId) -- loguear
    // esas sería puro ruido, indistinguible de publish_confirmed. Solo
    // intervalDays es una edición deliberada del usuario (slider de
    // intervalo en PublishingQueue.tsx, ver SyncPanel/PublishingQueue) --
    // es el único campo que se manda solo, nunca junto a los automáticos.
    if (intervalDays !== undefined) {
      await recordAuditEvent({
        userId, type: 'calendar_config_updated', platform,
        entity: { kind: 'calendar_config', id: platform },
        detail: { intervalDays },
      });
    }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/sync/calendar-config/:platform/skip-next — descarta el próximo
// desde mobile. Es una acción acotada al archivo que la central devolvió en
// GET; no expone el PATCH administrativo que permite fijar toda la agenda.
export const skipNextCalendarVideo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { platform } = req.params;
    const { fileId } = req.body as { fileId?: string };
    if (!['tiktok', 'instagram', 'youtube'].includes(platform) || !fileId) {
      res.status(400).json({ message: 'Plataforma o video no válido.' }); return;
    }

    const userId = req.user!.id;
    const file = await FileModel.findOne({ _id: fileId, userId }).select('platforms platforms_discarded').lean();
    if (!file) { res.status(404).json({ message: 'Video no encontrado.' }); return; }
    if ((file.platforms ?? []).includes(platform) || (file.platforms_discarded ?? []).includes(platform)) {
      res.status(409).json({ message: 'El video ya está resuelto para esta plataforma.' }); return;
    }

    await FileModel.updateOne(
      { _id: file._id, userId },
      { $addToSet: { platforms_discarded: platform } },
    );
    // No esperar al próximo GET para reconstruir el puntero: mobile necesita
    // que la central tenga el siguiente video desde la misma respuesta del
    // descarte. Es el mismo criterio de elegibilidad Y el mismo orden (ASC,
    // el más viejo pendiente primero) de getCalendarConfig.
    const nextFile = await FileModel.findOne({
      userId,
      status: { $ne: 'ELIMINADO_DISCO' },
      content_status: { $ne: 'descartado' },
      platforms: { $ne: platform },
      platforms_discarded: { $ne: platform },
    }).sort({ fecha_creacion: 1, _id: 1 }).select('file_name').lean();
    const db = (await import('mongoose')).default.connection.db!;
    await db.collection('platform_config').updateOne(
      { userId, platform },
      { $set: { nextVideoId: nextFile?.file_name ?? null, nextRemoteLibraryVideoId: null } },
    );
    res.json({ ok: true, nextVideoId: nextFile ? String(nextFile._id) : null });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
};
