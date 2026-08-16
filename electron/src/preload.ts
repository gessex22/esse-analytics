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
  // Busca otras PCs EsseAnalytics anunciadas por Bonjour en la LAN (Opción C,
  // cliente LAN -- ver ServerConnectionPanel.tsx). Tarda ~3s (ventana fija de
  // escaneo mDNS en main.ts), resuelve con la lista encontrada hasta ese momento.
  discoverServers: (): Promise<{ name: string; host: string; port: number; labMode: boolean }[]> =>
    ipcRenderer.invoke('bonjour:discover'),
  // El frontend lo usa para decidir si mostrar "Elegir carpeta" (Electron) o
  // solo el campo de texto manual (mismo frontend servido por LAN/túnel sin
  // Electron, o web remota) -- ver LibraryPanel.tsx.
  isElectron: true,
});
