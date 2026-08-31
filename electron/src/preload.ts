// Puente de contextIsolation entre el frontend (sandboxed, sin Node) y el main
// process. Antes NO existía ningún preload -- webPreferences no declaraba uno
// y contextIsolation:true dejaba al frontend sin ninguna forma de pedirle algo
// nativo a Electron (confirmado: ipcMain.handle('app:version', ...) en main.ts
// estaba sin usar, ningún preload lo exponía). Cualquier función nueva acá
// tiene que exponerse explícitamente vía contextBridge -- nunca ipcRenderer
// crudo, para no darle al frontend acceso genérico a IPC.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Abre el diálogo nativo de "Elegir carpeta" del sistema operativo (Explorador
  // de Windows / Finder en Mac). Devuelve la ruta elegida, o null si se canceló.
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFolder'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  // El frontend lo usa para decidir si mostrar "Elegir carpeta" (Electron) o
  // solo el campo de texto manual (mismo frontend servido por LAN/túnel sin
  // Electron, o web remota) -- ver LibraryPanel.tsx.
  isElectron: true,

  // Espeja el tema elegido (rojo/ámbar) en el userData para que las ventanas
  // NATIVAS de la app puedan usar la misma paleta -- hoy la pantalla de
  // "puerto ocupado", que se dibuja justamente cuando el frontend no puede
  // cargarse. Ver useTheme.ts.
  setUiTheme: (theme: string): Promise<boolean> => ipcRenderer.invoke('ui:set-theme', theme),

  // Solo lo usa dist/port-conflict.html (la pantalla de "puerto 4000
  // ocupado"). Comparte este preload porque es una ventana más de la misma
  // app; el frontend normal nunca llama a estos métodos.
  portConflict: {
    info: (): Promise<unknown> => ipcRenderer.invoke('port-conflict:info'),
    retry: (): Promise<{ ok: boolean; info?: unknown }> => ipcRenderer.invoke('port-conflict:retry'),
    copyDetails: (): Promise<boolean> => ipcRenderer.invoke('port-conflict:copy'),
    quit: (): Promise<void> => ipcRenderer.invoke('port-conflict:quit'),
  },
});
