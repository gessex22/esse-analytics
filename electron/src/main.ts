import { app, BrowserWindow, shell, dialog, ipcMain } from 'electron';
import path from 'path';
import { autoUpdater } from 'electron-updater';

let mainWindow: BrowserWindow | null = null;
const PORT = 4000;

function setupEnv() {
  // SQLite DB va a la carpeta de datos del usuario del sistema operativo
  process.env.SQLITE_DIR = app.getPath('userData');

  // Archivos estáticos del frontend
  if (app.isPackaged) {
    process.env.FRONTEND_DIST = path.join(process.resourcesPath, 'frontend-dist');
  } else {
    // En desarrollo: usa el dist del frontend si existe
    process.env.FRONTEND_DIST = path.join(__dirname, '../../frontend/dist');
  }

  process.env.PORT = String(PORT);
}

function startServer() {
  // El server bundle arranca Express al ser requerido
  require('./server.cjs');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'EsseAnalytics',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    // Sin barra de menú nativa
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Abrir links externos en el navegador del sistema, no en Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
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

app.whenReady().then(() => {
  setupEnv();
  startServer();

  // Espera a que Express esté listo antes de abrir la ventana
  setTimeout(createWindow, 800);

  if (app.isPackaged) setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Permite que el frontend pregunte la versión actual
  ipcMain.handle('app:version', () => app.getVersion());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
