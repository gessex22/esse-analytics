import express from 'express';
import os from 'os';
import { configRepo } from '../db/config.repo';
import { PLUGIN_GEMS, findPlugin, pluginStatus, startPlugin, stopPlugin, getProgress } from '../plugins';

const router = express.Router();

// ── GET /api/gems ─────────────────────────────────────────────────────────────
router.get('/api/gems', (_req, res) => {
  const pluginStatuses = PLUGIN_GEMS.map(g => ({ id: g.id, status: pluginStatus(g.id), progress: getProgress(g.id) }));

  // Gemas built-in: estado guardado en config.
  // Acceso Local está activo por defecto (solo se desactiva si el usuario lo apagó explícitamente).
  const localEnabled  = configRepo.get('gem_local_access_enabled') !== 'false';
  const backupEnabled = configRepo.get('gem_backup_enabled') === 'true';

  res.json([
    { id: 'esse_local_access', status: localEnabled  ? 'running' : 'installed' },
    { id: 'esse_backup',       status: backupEnabled ? 'running' : 'installed' },
    ...pluginStatuses,
  ]);
});

// ── POST /api/gems/:id/start ──────────────────────────────────────────────────
router.post('/api/gems/:id/start', (req, res) => {
  // Built-in: Acceso Local
  if (req.params.id === 'esse_local_access') {
    configRepo.set('gem_local_access_enabled', 'true');
    res.json({ status: 'running' });
    return;
  }

  // Built-in: Backup en línea
  if (req.params.id === 'esse_backup') {
    configRepo.set('gem_backup_enabled', 'true');
    res.json({ status: 'running' });
    return;
  }

  if (!findPlugin(req.params.id)) { res.status(404).json({ error: 'Gema no encontrada' }); return; }

  const result = startPlugin(req.params.id);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  res.json({ status: result.status });
});

// ── POST /api/gems/:id/stop ───────────────────────────────────────────────────
router.post('/api/gems/:id/stop', (req, res) => {
  if (req.params.id === 'esse_local_access') {
    configRepo.set('gem_local_access_enabled', 'false');
    res.json({ status: 'installed' });
    return;
  }

  if (req.params.id === 'esse_backup') {
    configRepo.set('gem_backup_enabled', 'false');
    res.json({ status: 'installed' });
    return;
  }

  if (!findPlugin(req.params.id)) { res.status(404).json({ error: 'Gema no encontrada' }); return; }
  res.json(stopPlugin(req.params.id));
});

// ── GET /api/gems/local-network ───────────────────────────────────────────────
router.get('/api/gems/local-network', (_req, res) => {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface ?? []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  const PORT = process.env.PORT || 4000;
  res.json({ ips, port: PORT, urls: ips.map(ip => `http://${ip}:${PORT}`) });
});

export default router;
