// Gestión compartida de los plugins externos (gemas tipo ejecutable): estado
// (instalado/corriendo) y arranque/parada del proceso. Lo usan gems.routes.ts
// (para los botones de la UI) y watcher.ts (para disparar esse_transcrip solo).
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

export const GEMS_DIR = path.join(os.homedir(), '.esse-analytics', 'gems');
fs.mkdirSync(GEMS_DIR, { recursive: true });

export const PLUGIN_GEMS = [
  {
    id:       'esse_transcrip',
    execName: process.platform === 'win32' ? 'esse_transcrip.exe' : 'esse_transcrip',
  },
  {
    id:       'esse_remote_access',
    execName: process.platform === 'win32' ? 'esse_remote.exe' : 'esse_remote',
  },
  {
    id:       'esse_maiden',
    execName: process.platform === 'win32' ? 'esse_maiden.exe' : 'esse_maiden',
  },
];

export type PluginStatus = 'not_installed' | 'installed' | 'running';

const running: Record<string, ChildProcess> = {};

export function findPlugin(id: string) {
  return PLUGIN_GEMS.find(g => g.id === id);
}

export function pluginStatus(id: string): PluginStatus {
  const gem = findPlugin(id);
  if (!gem) return 'not_installed';
  const p = path.join(GEMS_DIR, gem.execName);
  if (!fs.existsSync(p)) return 'not_installed';
  if (running[gem.id])   return 'running';
  return 'installed';
}

/** Arranca un plugin instalado. No hace nada si ya está corriendo o no está instalado. */
export function startPlugin(id: string, extraArgs: string[] = []): { ok: boolean; status: PluginStatus; error?: string } {
  const gem = findPlugin(id);
  if (!gem) return { ok: false, status: 'not_installed', error: 'Gema no encontrada' };

  const status = pluginStatus(id);
  if (status === 'not_installed') return { ok: false, status, error: 'No instalada' };
  if (status === 'running')       return { ok: true, status };

  const execPath = path.join(GEMS_DIR, gem.execName);
  const PORT = process.env.PORT || 4000;

  let proc: ChildProcess;
  try {
    // spawn() puede tirar sincrónicamente (ej. ejecutable corrupto/formato inválido
    // en Windows) además de emitir 'error' de forma async — sin ninguna de las dos
    // protecciones, un plugin roto crashea TODO el proceso de Node, no solo el plugin.
    proc = spawn(execPath, ['--api', `http://localhost:${PORT}`, ...extraArgs], { detached: false });
  } catch (err: any) {
    console.error(`[plugins] No se pudo iniciar ${id}:`, err.message);
    return { ok: false, status: 'installed', error: err.message };
  }

  running[gem.id] = proc;
  proc.on('exit', () => { delete running[gem.id]; });
  proc.on('error', (err) => {
    console.error(`[plugins] No se pudo iniciar ${id}:`, err.message);
    delete running[gem.id];
  });

  return { ok: true, status: 'running' };
}

export function stopPlugin(id: string): { status: PluginStatus } {
  running[id]?.kill();
  delete running[id];
  return { status: pluginStatus(id) };
}
