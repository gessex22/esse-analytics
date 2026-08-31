import net from 'net';
import { execFile } from 'child_process';

// Detección de "puerto ocupado" para el arranque de Electron.
//
// Por qué existe: el local-backend hace `app.listen(4000)` y, si el puerto ya
// está tomado, el evento 'error' del server quedaba sin manejar -> excepción no
// capturada dentro del proceso main de Electron. Peor todavía: la ventana se
// abría igual contra http://localhost:4000, así que el usuario terminaba
// viendo la interfaz DEL OTRO programa adentro de EsseAnalytics, o una página
// de error del navegador, sin ninguna explicación.
//
// Nada de esto necesita permisos de administrador: `netstat -ano` (Windows) y
// `lsof` (macOS/Linux) listan el PID dueño de un puerto con permisos normales.

export interface PortUser {
  pid: number;
  /** Nombre del ejecutable, si se pudo resolver ("chrome.exe", "node"). */
  name: string | null;
  /** Línea cruda de la herramienta del sistema — para "Copiar detalles". */
  raw: string;
}

/**
 * ¿Se puede bindear el puerto? Intenta escuchar de verdad en 0.0.0.0 (la misma
 * interfaz que usa local-backend) y suelta el socket enseguida.
 *
 * ⚠ NO alcanza por sí solo en Windows, y esto está comprobado en esta máquina:
 * Node/libuv bindea con SO_REUSEADDR, y la semántica de Windows permite que
 * DOS procesos escuchen el mismo puerto si el primero también usó
 * SO_REUSEADDR. Resultado: este chequeo devolvía `true` (libre) con otro
 * proceso ya escuchando en 0.0.0.0:4000, la app arrancaba "bien" y las
 * conexiones se repartían de forma impredecible entre los dos servidores.
 * (`exclusive: true` tampoco lo arregla: solo impide que OTROS se sumen
 * después a NUESTRO socket, no que nosotros nos sumemos a uno existente.)
 *
 * Por eso el veredicto real lo da `checkPort()`, que además pregunta por la
 * tabla de sockets del sistema. Esto queda como segunda señal, útil para los
 * casos que netstat/lsof no cubren: puerto reservado por el SO (EACCES,
 * rangos excluidos por Hyper-V/WSL) o herramienta del sistema no disponible.
 */
export function canBindPort(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE = ocupado. EACCES = puerto reservado/bloqueado por el
      // sistema (Windows tiene rangos excluidos por Hyper-V/WSL) — para el
      // usuario es el mismo problema: no podemos usarlo.
      resolve(!(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
    });
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, windowsHide: true }, (err, stdout) => {
      // Nunca reventar por esto: el detalle del proceso es un extra, la
      // pantalla de conflicto tiene que aparecer igual sin él.
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

async function findPortUsersWindows(port: number): Promise<PortUser[]> {
  // netstat -ano: Proto | Dirección local | Dirección remota | Estado | PID
  const stdout = await run('netstat', ['-ano', '-p', 'tcp']);
  const byPid = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [, local, , state, pidText] = parts;
    // Solo el que está ESCUCHANDO en ese puerto — las conexiones salientes
    // hacia :4000 de otra máquina no son las que nos bloquean.
    if (!/LISTEN/i.test(state)) continue;
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(pidText);
    if (Number.isFinite(pid) && pid > 0 && !byPid.has(pid)) byPid.set(pid, line.trim());
  }

  const users: PortUser[] = [];
  for (const [pid, raw] of byPid) {
    // /FO CSV /NH: una línea por proceso, sin encabezado -> "nombre.exe","1234",...
    const tasklist = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const match = tasklist.match(/^"([^"]+)"/);
    users.push({ pid, name: match ? match[1] : null, raw });
  }
  return users;
}

async function findPortUsersUnix(port: number): Promise<PortUser[]> {
  const stdout = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  const users: PortUser[] = [];
  const seen = new Set<number>();
  for (const line of stdout.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[1]);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    users.push({ pid, name: parts[0] || null, raw: line.trim() });
  }
  return users;
}

/**
 * Quién está escuchando en ese puerto. Devuelve [] si la herramienta del
 * sistema no existe, tarda demasiado o no dice nada — el llamador tiene que
 * poder mostrar la pantalla igual sin esta información.
 */
export async function findPortUsers(port: number): Promise<PortUser[]> {
  try {
    return process.platform === 'win32'
      ? await findPortUsersWindows(port)
      : await findPortUsersUnix(port);
  } catch {
    return [];
  }
}

export interface PortStatus {
  free: boolean;
  users: PortUser[];
}

/**
 * Veredicto de arranque: ¿está libre el puerto, y si no, quién lo tiene?
 *
 * Se consulta primero la tabla del sistema (netstat/lsof): si YA hay alguien
 * escuchando, el puerto está ocupado aunque Windows nos dejara bindearlo
 * igual (ver el comentario largo en canBindPort). El bind queda como segunda
 * señal para lo que esa tabla no cubre.
 *
 * Entre este chequeo y el listen real del backend hay una ventana de carrera
 * de milisegundos; es aceptable porque no es la única defensa — local-backend
 * maneja su propio EADDRINUSE y avisa al main process (ver server.ts y el
 * listener 'esse:port-conflict' en main.ts).
 */
export async function checkPort(port: number): Promise<PortStatus> {
  const users = await findPortUsers(port);
  if (users.length > 0) return { free: false, users };
  return { free: await canBindPort(port), users: [] };
}

/** Comando sugerido para cerrar el proceso, según sistema operativo. */
export function killCommandFor(pid: number): string {
  return process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
}
