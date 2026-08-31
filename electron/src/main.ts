import { app, BrowserWindow, shell, dialog, ipcMain, clipboard } from 'electron';
import path from 'path';
import fs from 'fs';
import { autoUpdater } from 'electron-updater';
import { Bonjour } from 'bonjour-service';
import { checkPort, killCommandFor, PortUser } from './port-check';

let mainWindow: BrowserWindow | null = null;
// Ventana de "puerto ocupado" -- se abre EN LUGAR de la principal cuando el
// backend local no puede arrancar (ver bootOrShowPortConflict).
let conflictWindow: BrowserWindow | null = null;
let serverStarted = false;
// Última foto de quién tenía el puerto -- la calcula checkPort() en el arranque
// y en cada "Reintentar", y la consume la pantalla de conflicto.
let lastPortUsers: PortUser[] = [];
let bonjour: InstanceType<typeof Bonjour> | null = null;
let announcedService: ReturnType<InstanceType<typeof Bonjour>['publish']> | null = null;
const PORT = 4000;

// Una sola instancia por PC. El caso más común de "puerto 4000 ocupado" era la
// propia app abierta dos veces: la segunda copia reventaba con EADDRINUSE (o
// peor, mostraba la UI servida por la PRIMERA dentro de una ventana nueva, con
// dos procesos peleando por la misma SQLite). Con el lock, la segunda copia se
// cierra sola y le devuelve el foco a la que ya estaba.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

// Ver electron/package.json (script "dev:lab") y local-backend/src/config.ts.
// SOLO se activa si quien lanzó `electron .` ya tenía ESSENALYTICS_LAB_MODE=1
// en el entorno (heredado del shell) -- nunca hay una preferencia de la app
// que lo prenda, y un build distribuido (npm run dist:win, sin pasar por
// dev:lab) jamás lo ve seteado. server.cjs (el bundle de local-backend) hace
// exactamente el mismo chequeo por su cuenta; esto es solo para loguear y
// diferenciar el nombre del servicio Bonjour/el título de ventana.
const LAB_MODE = process.env.ESSENALYTICS_LAB_MODE === '1';

function setupEnv() {
  // SQLite DB va a la carpeta de datos del usuario del sistema operativo.
  // El nombre de archivo (esse_local.db vs esse_lab.db) lo decide
  // local-backend/src/db/database.ts según ESSENALYTICS_LAB_MODE -- nunca hay
  // que crear una carpeta distinta a mano para que queden aisladas.
  process.env.SQLITE_DIR = app.getPath('userData');

  // Archivos estáticos del frontend
  if (app.isPackaged) {
    process.env.FRONTEND_DIST = path.join(process.resourcesPath, 'frontend-dist');
  } else {
    // En desarrollo: usa el dist del frontend si existe
    process.env.FRONTEND_DIST = path.join(__dirname, '../../frontend/dist');
  }

  process.env.PORT = String(PORT);
  // YOUTUBE_API_KEY y CLIENT_REGISTER_KEY se inyectan en build-time dentro del bundle
  // (server.cjs) desde electron/.env.build — NO viven en el código fuente.
  process.env.CENTRAL_API = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

  if (LAB_MODE) {
    // Reenviado explícito (ya llega heredado del shell, esto es solo defensivo
    // y documenta la intención) -- local-backend/src/config.ts lo lee para
    // dejar de hablar con CENTRAL_API y hablar con LAB_API en su lugar.
    process.env.ESSENALYTICS_LAB_MODE = '1';
    process.env.LAB_API = process.env.LAB_API || 'http://127.0.0.1:5055';
    console.log(`[electron] ESSENALYTICS_LAB_MODE=1 -- Laboratorio en ${process.env.LAB_API}, SQLite aislada, uploaders mock.`);
  }
}

function startServer() {
  // Idempotente: el botón "Reintentar" de la pantalla de conflicto vuelve a
  // pasar por acá una vez que el puerto se liberó.
  if (serverStarted) return;
  serverStarted = true;
  // El server bundle arranca Express al ser requerido
  require('./server.cjs');
  // Anuncia la PC por Bonjour/mDNS para que Android/iOS puedan encontrarla
  // sin pedir al usuario que escriba la IP. La URL manual sigue siendo el
  // respaldo para redes que bloquean multicast.
  bonjour = new Bonjour();
  // Prefijo "[Laboratorio]" en el nombre del servicio -- para que quien esté
  // eligiendo una PC por descubrimiento LAN desde iOS/Android no confunda esta
  // instancia (datos simulados) con su PC real si ambas están prendidas a la vez.
  announcedService = bonjour.publish({
    name: `${LAB_MODE ? '[Laboratorio] ' : ''}EsseAnalytics PC (${require('os').hostname()})`,
    type: 'esseanalytics',
    port: PORT,
    protocol: 'tcp',
    txt: { version: app.getVersion(), service: 'esseanalytics', labMode: LAB_MODE ? '1' : '0' },
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: LAB_MODE ? 'EsseAnalytics — Laboratorio' : 'EsseAnalytics',
    // Fondo oscuro del tema → sin flash blanco al abrir. Barra de título NATIVA
    // (la integrada tapaba botones en Windows y se veía mal en Mac).
    backgroundColor: '#0c0c14',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    // Sin barra de menú nativa
    autoHideMenuBar: true,
  });

  // Mostrar recién cuando el contenido está listo (evita parpadeo).
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Abrir links externos en el navegador del sistema, no en Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// El tema elegido (rojo/ámbar) vive en el localStorage del frontend, que es
// inalcanzable justo cuando más falta hace: si el backend no arrancó, la página
// que lo guarda nunca se carga. Por eso el frontend lo espeja acá (ver
// electronAPI.setUiTheme -> useTheme.ts) en un JSON mínimo del userData, y la
// pantalla de conflicto puede pintarse con la paleta correcta.
function uiStatePath() {
  return path.join(app.getPath('userData'), 'ui-state.json');
}

function saveUiTheme(theme: string) {
  if (theme !== 'rojo' && theme !== 'ambar') return;
  try {
    fs.writeFileSync(uiStatePath(), JSON.stringify({ theme }), 'utf8');
  } catch {
    // Preferencia cosmética: si no se puede escribir, la pantalla usa el
    // tema por defecto y listo.
  }
}

function readUiTheme(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(uiStatePath(), 'utf8'));
    return parsed?.theme === 'ambar' ? 'ambar' : 'rojo';
  } catch {
    return 'rojo';
  }
}

// Datos que consume port-conflict.html (vía preload -> electronAPI.portConflict).
// Recibe la lista ya consultada por checkPort() para no pagar dos veces el
// netstat/tasklist en el mismo arranque.
function buildPortConflictInfo(users: PortUser[]) {
  return {
    port: PORT,
    platform: process.platform,
    theme: readUiTheme(),
    users: users.map((user) => ({
      pid: user.pid,
      name: user.name,
      raw: user.raw,
      killCommand: killCommandFor(user.pid),
      // Caso frecuente y con una salida distinta al resto ("ya la tenés
      // abierta"), así que se marca acá y no en la página.
      isEsseAnalytics: /esse/i.test(user.name || ''),
    })),
  };
}

async function showPortConflictWindow() {
  if (conflictWindow) {
    conflictWindow.focus();
    return;
  }
  conflictWindow = new BrowserWindow({
    width: 880,
    height: 700,
    minWidth: 640,
    minHeight: 520,
    title: 'EsseAnalytics — puerto ocupado',
    backgroundColor: '#09090d',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  conflictWindow.once('ready-to-show', () => conflictWindow?.show());
  conflictWindow.on('closed', () => { conflictWindow = null; });
  // Archivo local, no http://localhost:4000 -- justamente ese origen es el que
  // está en manos de otro programa.
  await conflictWindow.loadFile(path.join(__dirname, 'port-conflict.html'));
}

// Punto de entrada real del arranque: si el puerto está libre, todo sigue como
// siempre; si no, no se levanta nada y se explica el problema en pantalla.
async function bootOrShowPortConflict() {
  const status = await checkPort(PORT);
  if (status.free) {
    startServer();
    // Espera a que Express esté listo antes de abrir la ventana
    setTimeout(createWindow, 800);
    return;
  }
  lastPortUsers = status.users;
  const quien = status.users.map((user) => `${user.name || '?'} (PID ${user.pid})`).join(', ') || 'proceso desconocido';
  console.error(`[electron] El puerto ${PORT} está ocupado por ${quien} -- no se arranca el backend local.`);
  await showPortConflictWindow();
}

function setupPortConflictIPC() {
  ipcMain.handle('port-conflict:info', () => buildPortConflictInfo(lastPortUsers));

  ipcMain.handle('port-conflict:retry', async () => {
    const status = await checkPort(PORT);
    if (!status.free) {
      lastPortUsers = status.users;
      return { ok: false, info: buildPortConflictInfo(status.users) };
    }
    startServer();
    // La ventana de conflicto se cierra DESPUÉS de crear la principal: si
    // quedara cero ventanas abiertas por un instante, 'window-all-closed'
    // cerraría la app entera en Windows/Linux.
    const previous = conflictWindow;
    conflictWindow = null;
    setTimeout(() => {
      createWindow();
      previous?.close();
    }, 800);
    return { ok: true };
  });

  ipcMain.handle('port-conflict:copy', async () => {
    const info = buildPortConflictInfo(lastPortUsers);
    const lines = [
      `EsseAnalytics ${app.getVersion()} -- puerto ${info.port} ocupado (${info.platform})`,
      ...(info.users.length
        ? info.users.map((user) => `PID ${user.pid} · ${user.name || 'desconocido'} · ${user.raw}`)
        : ['No se pudo identificar el proceso dueño del puerto.']),
    ];
    clipboard.writeText(lines.join(String.fromCharCode(10)));
    return true;
  });

  ipcMain.handle('port-conflict:quit', () => app.quit());
}

function setupUiStateIPC() {
  ipcMain.handle('ui:set-theme', (_event, theme: string) => {
    saveUiTheme(theme);
    return true;
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
      type: 'info',
      title: 'Actualización disponible',
      message: `Nueva versión: ${info.version}`,
      detail: 'Descargando en segundo plano. Te avisaremos cuando esté lista.',
      buttons: ['OK'],
    });
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'question',
      title: 'Actualización lista',
      message: '¿Instalar actualización ahora?',
      detail: 'La app se reiniciará para aplicar la nueva versión.',
      buttons: ['Instalar y reiniciar', 'Más tarde'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', () => {
    // Silencioso — no molestar al usuario si el check falla
  });

  // Verificar 4 segundos después del arranque para no bloquear la carga
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
}

app.on('second-instance', () => {
  // Alguien volvió a abrir la app: en vez de una segunda copia peleando por el
  // puerto, se trae al frente la ventana que ya estaba.
  const existing = mainWindow || conflictWindow;
  if (!existing) return;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
});

// Red de contención de la carrera: entre isPortFree() y el listen real del
// backend hay milisegundos en los que otro programa puede tomar el puerto.
// local-backend emite este evento desde su handler de EADDRINUSE (ver
// local-backend/src/server.ts) en vez de tirar una excepción sin capturar.
(process as NodeJS.EventEmitter).on('esse:port-conflict', () => {
  serverStarted = false;
  mainWindow?.destroy();
  mainWindow = null;
  void (async () => {
    lastPortUsers = (await checkPort(PORT)).users;
    await showPortConflictWindow();
  })();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  setupEnv();
  setupUiStateIPC();
  setupPortConflictIPC();
  void bootOrShowPortConflict();

  if (app.isPackaged) setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    // Si el backend nunca llegó a arrancar (puerto ocupado), reabrir la
    // ventana principal solo mostraría la app del otro programa.
    if (serverStarted) createWindow();
    else void bootOrShowPortConflict();
  });

  // Permite que el frontend pregunte la versión actual
  ipcMain.handle('app:version', () => app.getVersion());

  // Diálogo nativo de carpeta -- ver preload.ts (contextBridge) y
  // frontend/src/components/LibraryPanel.tsx ("Elegir carpeta"). Antes el
  // único modo era tipear la ruta a mano; esto la reemplaza sin sacar el
  // campo (sigue siendo el fallback cuando el mismo frontend corre fuera de
  // Electron, LAN/túnel sin la app de escritorio).
  ipcMain.handle('dialog:selectFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  announcedService?.stop();
  bonjour?.destroy();
});
