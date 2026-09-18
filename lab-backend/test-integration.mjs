import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// El Laboratorio puede contener escenarios que alguien está usando desde un
// teléfono. Los tests reciben un store descartable ANTES de importar config.ts;
// nunca leen ni reescriben lab-data/lab.json.
const dataDir = mkdtempSync(join(tmpdir(), 'esse-lab-tests-'));
try {
  const result = spawnSync('node', ['--import', 'tsx', '--test', 'src/**/*.test.ts'], {
    cwd: new URL('.', import.meta.url),
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, LAB_DATA_DIR: dataDir, ESSENALYTICS_LAB_MODE: '1' },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
