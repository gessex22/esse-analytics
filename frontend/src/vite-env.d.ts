/// <reference types="vite/client" />
declare const __APP_VERSION__: string;

// Expuesto por electron/src/preload.ts vía contextBridge -- solo existe
// cuando este mismo frontend corre empaquetado en Electron. Servido por
// LAN/túnel sin la app de escritorio (o la web remota), window.electronAPI
// es undefined -- todo código que lo use tiene que chequear eso antes.
interface DiscoveredEsseServer {
  name: string;
  host: string;
  port: number;
  labMode: boolean;
}

interface Window {
  electronAPI?: {
    selectFolder: () => Promise<string | null>;
    getAppVersion: () => Promise<string>;
    // Descubrimiento Bonjour de otras PCs EsseAnalytics en la LAN -- ver
    // ServerConnectionPanel.tsx (Opción C, cliente LAN) y electron/src/main.ts
    // (ipcMain.handle('bonjour:discover', ...)).
    discoverServers: () => Promise<DiscoveredEsseServer[]>;
    isElectron: true;
  };
}