import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { configRepo } from '../db/config.repo';

const router = express.Router();

const GEMS_DIR = path.join(os.homedir(), '.esse-analytics', 'gems');
fs.mkdirSync(GEMS_DIR, { recursive: true });

// Gemas que requieren ejecutable externo
const PLUGIN_GEMS = [
  {
    id:       'esse_transcrip',
    execName: process.platform === 'win32' ? 'esse_transcrip.exe' : 'esse_transcrip',
  },
  {
    id:       'esse_remote_access',
    execName: process.platform === 'win32' ? 'esse_remote.exe' : 'esse_remote',
  },
];

const running: Record<string, ChildProcess> = {};

function pluginStatus(gem: typeof PLUGIN_GEMS[0]): 'not_installed' | 'installed' | 'running' {
  const p = path.join(GEMS_DIR, gem.execName);
  if (!fs.existsSync(p)) return 'not_installed';
  if (running[gem.id])   return 'running';
  return 'installed';
}

// ── GET /api/gems ─────────────────────────────────────────────────────────────
router.get('/api/gems', (_req, res) => {
  // Gemas plugin
  const pluginStatuses = PLUGIN_GEMS.map(g => ({ id: g.id, status: pluginStatus(g) }));

  // Gemas built-in: estado guardado en config
  const localEnabled = configRepo.get('gem_local_access_enabled') === 'true';

  res.json([
    { id: 'esse_local_access', status: localEnabled ? 'running' : 'installed' },
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

  const gem = PLUGIN_GEMS.find(g => g.id === req.params.id);
  if (!gem) { res.status(404).json({ error: 'Gema no encontrada' }); return; }
  if (pluginStatus(gem) === 'not_installed') { res.status(400).json({ error: 'No instalada' }); return; }
  if (running[gem.id]) { res.json({ status: 'running' }); return; }

  const execPath = path.join(GEMS_DIR, gem.execName);
  const PORT = process.env.PORT || 4000;
  const proc = spawn(execPath, ['--api', `http://localhost:${PORT}`], { detached: false });
  running[gem.id] = proc;
  proc.on('exit', () => { delete running[gem.id]; });

  res.json({ status: 'running' });
});

// ── POST /api/gems/:id/stop ───────────────────────────────────────────────────
router.post('/api/gems/:id/stop', (req, res) => {
  if (req.params.id === 'esse_local_access') {
    configRepo.set('gem_local_access_enabled', 'false');
    res.json({ status: 'installed' });
    return;
  }

  const gem = PLUGIN_GEMS.find(g => g.id === req.params.id);
  if (!gem) { res.status(404).json({ error: 'Gema no encontrada' }); return; }

  running[gem.id]?.kill();
  delete running[gem.id];
  res.json({ status: 'installed' });
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
