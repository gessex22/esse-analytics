// Corre la suite EXIGIENDO Mongo (ESSE_REQUIRE_MONGO=1): sin él, el harness
// integral falla en vez de saltear.
//
// Existe como archivo y no como una env var inline en el script de npm porque
// eso no es portable entre cmd y sh, y este comando lo tiene que poder correr
// tanto el pipeline como cualquiera en su máquina. Sin dependencias nuevas
// (cross-env no está instalado y no vale la pena sumarlo por una línea).
//
// El motivo de fondo: con el skip por defecto, no tener Mongo daba 3 skips y
// exit code 0 -- un merge se veía verde sin haber probado la convergencia.
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['tsx', '--test', 'src/**/*.test.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ESSE_REQUIRE_MONGO: '1' },
});
process.exit(r.status ?? 1);
