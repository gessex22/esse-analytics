import { backupService } from "./api";

// Punto único para los jobs de sincronización del dispositivo central (premium,
// Electron/LAN). Antes cada feature disparaba su propio job por su cuenta: push
// cada 15min en un timer aislado (useAutoBackup), un pull que solo corría una
// vez si la PC no tenía carpeta configurada (App.tsx), y el precargado a
// Biblioteca remota atado únicamente al instante exacto de publicar desde
// Subir. Nada volvía a converger si alguno se saltaba un paso (por eso el
// Calendario y el precargado se desalineaban en silencio). Acá se corren los
// tres jobs (push, pull, ensurePreload) como una sola unidad best-effort, con
// un cooldown compartido para que no importa cuántos lugares disparen el tick,
// nunca golpea la central más seguido de lo necesario.
const MIN_GAP_MS = 5 * 60 * 1000; // no repetir el tick más seguido que cada 5 min
let lastTick = 0;

export async function runSyncTick(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastTick < MIN_GAP_MS) return;
  lastTick = now;

  await backupService.push().catch(() => {});
  await backupService.pull().catch(() => {});
  await backupService.ensurePreload().catch(() => {});
}
