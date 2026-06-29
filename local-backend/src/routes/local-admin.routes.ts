import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { verifyToken, AuthRequest } from '../middleware/auth.middleware';
import { configRepo } from '../db/config.repo';
import { db } from '../db/database';
import { fileRepo } from '../db/file.repo';

const router = Router();

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// Devuelve el secreto de instalación, generándolo la primera vez.
export function getOrCreateInstallId(): string {
  let id = configRepo.get('install_id');
  if (!id) {
    id = randomUUID() + randomUUID().replace(/-/g, '');
    configRepo.set('install_id', id);
  }
  return id;
}

// POST /api/local/wipe — limpia todas las tablas locales
router.post('/api/local/wipe', verifyToken, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'todopoderoso') {
    res.status(403).json({ message: 'Solo el administrador puede hacer esto.' });
    return;
  }
  try {
    const results = configRepo.wipeAll();
    res.json({ ok: true, cleared: results });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al limpiar.', detail: err.message });
  }
});

// GET /api/local/owner — quién posee esta instancia (null si nadie aún)
router.get('/api/local/owner', (_req, res) => {
  try {
    const owner = configRepo.getOwner();
    res.json({ username: owner?.username ?? null });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al leer owner.', detail: err.message });
  }
});

// POST /api/local/owner — fija el owner tras el primer login y registra el
// secreto de instalación en la central (autoriza futuras operaciones destructivas).
router.post('/api/local/owner', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const existing = configRepo.getOwner();
    let switched = false;
    if (existing && existing.username !== req.user!.username) {
      // Inicia un usuario DISTINTO al dueño de esta PC → reiniciar local (borrar todo)
      // y adoptar al nuevo. Sus datos se repueblan desde la nube (calendario siempre;
      // catálogo solo si es premium, porque ese endpoint exige premium).
      configRepo.wipeAll();
      configRepo.clearOwner();
      switched = true;
    }
    configRepo.setOwner(req.user!.username);

    // Vincular el secreto de instalación a la cuenta en la central.
    const installId = getOrCreateInstallId();
    await fetch(`${CENTRAL}/api/auth/link-install`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: req.headers.authorization || '',
      },
      body: JSON.stringify({ installId }),
    }).catch(() => {});

    res.json({ ok: true, username: req.user!.username, switched });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al fijar owner.', detail: err.message });
  }
});

// DELETE /api/local/owner — libera la instancia
router.delete('/api/local/owner', verifyToken, (req: AuthRequest, res: Response) => {
  try {
    const existing = configRepo.getOwner();
    if (existing && existing.username !== req.user!.username) {
      res.status(403).json({ message: 'Solo el dueño de esta instancia puede liberarla.' });
      return;
    }
    configRepo.clearOwner();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al liberar owner.', detail: err.message });
  }
});

// POST /api/local/owner/reset — libera la instancia sin necesitar token.
// Útil cuando la cuenta vinculada fue dada de baja y el usuario no puede loguear.
// Solo accesible desde localhost.
router.post('/api/local/owner/reset', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ message: 'Solo accesible desde localhost.' });
    return;
  }
  try {
    configRepo.clearOwner();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ message: 'Error al liberar owner.', detail: err.message });
  }
});

// POST /api/local/reset-all — wipe completo + desvincular, sin auth.
// Solo accesible desde localhost. Pensado para el "eliminar todo" desde el login
// cuando el usuario no tiene token (olvidó la contraseña).
router.post('/api/local/reset-all', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ message: 'Solo accesible desde localhost.' });
    return;
  }
  // clearOwner es lo crítico para "cambiar de cuenta" → debe correr SIEMPRE,
  // aunque el wipe de datos falle parcialmente.
  let cleared: Record<string, number> = {};
  try { cleared = configRepo.wipeAll(); } catch (e: any) { cleared = { _wipeError: -1 }; }
  try {
    configRepo.clearOwner();
  } catch (err: any) {
    res.status(500).json({ message: 'No se pudo desvincular la cuenta.', detail: err.message });
    return;
  }
  res.json({ ok: true, cleared });
});

// GET /api/local/health
router.get('/api/local/health', (_req, res) => {
  res.json({ local: true, db: 'sqlite' });
});

// POST /api/local/admin/import-calendar — recupera platform_config (último publicado,
// fecha, intervalo y próximo por plataforma) desde un dump externo (Mongo vieja).
// Resuelve los títulos guardados a ids locales por file_name. Localhost-only.
// Body: { configs: [{ platform, lastPublishedTitle, lastPublishedDate, intervalDays, nextTitle }] }
router.post('/api/local/admin/import-calendar', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) { res.status(403).json({ message: 'Solo accesible desde localhost.' }); return; }

  const configs = (req.body?.configs ?? []) as Array<{
    platform?: string; lastPublishedTitle?: string; lastPublishedDate?: string;
    intervalDays?: number; nextTitle?: string;
  }>;
  if (!Array.isArray(configs) || configs.length === 0) {
    res.status(400).json({ error: 'configs[] requerido' }); return;
  }

  const result: Record<string, any> = {};
  for (const c of configs) {
    if (!c.platform || !['youtube', 'tiktok', 'instagram'].includes(c.platform)) continue;
    const lastFile = c.lastPublishedTitle ? fileRepo.findByName(c.lastPublishedTitle) : undefined;
    const nextFile = c.nextTitle ? fileRepo.findByName(c.nextTitle) : undefined;
    configRepo.setPlatformConfig(c.platform, {
      ...(c.lastPublishedTitle !== undefined ? { last_published_title: c.lastPublishedTitle } : {}),
      ...(c.lastPublishedDate  !== undefined ? { last_published_date:  c.lastPublishedDate  } : {}),
      ...(c.intervalDays       !== undefined ? { interval_days:        c.intervalDays       } : {}),
      last_video_id: lastFile ? String(lastFile.id) : null,
      next_video_id: nextFile ? String(nextFile.id) : null,
    });
    result[c.platform] = {
      lastResolved: lastFile ? lastFile.id : `NO-MATCH(${c.lastPublishedTitle})`,
      nextResolved: nextFile ? nextFile.id : `NO-MATCH(${c.nextTitle})`,
    };
  }

  res.json({ ok: true, imported: Object.keys(result).length, result });
});

// POST /api/local/admin/import-platforms — aplica platforms desde un dump externo (Mongo vieja).
// Body: { items: [{ file_name, platforms[], platforms_discarded[] }] }
// Solo rellena archivos cuyo platforms local esté vacío (no pisa datos ya presentes).
// Localhost-only.
router.post('/api/local/admin/import-platforms', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ message: 'Solo accesible desde localhost.' });
    return;
  }

  const items = (req.body?.items ?? []) as Array<{ file_name?: string; platforms?: string[]; platforms_discarded?: string[] }>;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items[] requerido' });
    return;
  }

  // Índice local por file_name (puede haber duplicados; aplicamos a todos los que coincidan).
  const { rows } = fileRepo.findAll({ limit: 100000, offset: 0 });
  const byName = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byName.get(r.file_name) ?? [];
    arr.push(r);
    byName.set(r.file_name, arr);
  }

  let matched = 0, updated = 0, skippedHadData = 0, noMatch = 0;

  const applyAll = db.transaction(() => {
    for (const it of items) {
      if (!it.file_name) continue;
      const locals = byName.get(it.file_name);
      if (!locals || locals.length === 0) { noMatch++; continue; }
      for (const local of locals) {
        matched++;
        const localEmpty = local.platforms.length === 0 && local.platforms_discarded.length === 0;
        if (!localEmpty) { skippedHadData++; continue; }
        fileRepo.update(local.id, {
          platforms:           (it.platforms ?? []) as any,
          platforms_discarded: (it.platforms_discarded ?? []) as any,
        });
        updated++;
      }
    }
  });

  try {
    applyAll();
    res.json({ ok: true, received: items.length, matched, updated, skippedHadData, noMatch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/local/admin/migrate-platforms — backfill manual de files.platforms desde platform_videos
// Localhost-only (sin token): operación de mantenimiento inofensiva.
router.post('/api/local/admin/migrate-platforms', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocalhost) {
    res.status(403).json({ message: 'Solo accesible desde localhost.' });
    return;
  }
  try {
    // Diagnóstico: cuántos registros hay en platform_videos con linked_file_id
    const pvCount = (db.prepare('SELECT COUNT(*) as n FROM platform_videos WHERE linked_file_id IS NOT NULL').get() as any).n;
    const pvTotal = (db.prepare('SELECT COUNT(*) as n FROM platform_videos').get() as any).n;
    const filesEmpty = (db.prepare("SELECT COUNT(*) as n FROM files WHERE json_array_length(platforms) = 0").get() as any).n;

    // Backfill desde platform_videos
    db.prepare(`
      UPDATE files
      SET platforms = (
        SELECT json_group_array(p) FROM (
          SELECT DISTINCT pv.platform AS p
          FROM platform_videos pv
          WHERE pv.linked_file_id = files.id
            AND pv.platform IS NOT NULL
        )
      )
      WHERE json_array_length(platforms) = 0
        AND EXISTS (
          SELECT 1 FROM platform_videos pv WHERE pv.linked_file_id = files.id
        )
    `).run();

    // Backfill desde publishing_status (legado)
    db.prepare(`
      UPDATE files
      SET platforms = (
        SELECT json_group_array(p) FROM (
          SELECT 'youtube'   AS p WHERE (SELECT youtube_published   FROM publishing_status ps WHERE ps.file_id = files.id LIMIT 1) = 1
          UNION ALL
          SELECT 'instagram' AS p WHERE (SELECT instagram_published FROM publishing_status ps WHERE ps.file_id = files.id LIMIT 1) = 1
          UNION ALL
          SELECT 'tiktok'    AS p WHERE (SELECT tiktok_published    FROM publishing_status ps WHERE ps.file_id = files.id LIMIT 1) = 1
        )
      )
      WHERE json_array_length(platforms) = 0
        AND EXISTS (
          SELECT 1 FROM publishing_status ps
          WHERE ps.file_id = files.id
            AND (ps.youtube_published = 1 OR ps.instagram_published = 1 OR ps.tiktok_published = 1)
        )
    `).run();

    const filesEmptyAfter = (db.prepare("SELECT COUNT(*) as n FROM files WHERE json_array_length(platforms) = 0").get() as any).n;

    // Muestra qué quedó en platform_videos para diagnóstico
    const sample = db.prepare('SELECT platform, platform_id, linked_file_id FROM platform_videos LIMIT 20').all();

    res.json({
      ok: true,
      platform_videos: { total: pvTotal, with_linked_file_id: pvCount },
      files_empty_platforms_before: filesEmpty,
      files_empty_platforms_after:  filesEmptyAfter,
      fixed: filesEmpty - filesEmptyAfter,
      platform_videos_sample: sample,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
