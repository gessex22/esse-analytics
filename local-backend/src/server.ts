import './db/database'; // inicializa SQLite y crea las tablas
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import videoRoutes            from './routes/video.routes';
import streamRoutes           from './routes/stream.routes';
import scanRoutes             from './routes/scan.routes';
import publishingStatusRoutes from './routes/publishing-status.routes';
import syncRoutes             from './routes/sync.routes';
import authProxyRoutes        from './routes/auth-proxy.routes';
import localAdminRoutes       from './routes/local-admin.routes';
import youtubeUploadRoutes    from './routes/youtube-upload.routes';
import transcriptRoutes       from './routes/transcript.routes';
import ideaRoutes             from './routes/idea.routes';
import gemsRoutes             from './routes/gems.routes';
import backupSyncRoutes       from './routes/backup-sync.routes';
import tiktokUploadRoutes     from './routes/tiktok-upload.routes';
import instagramUploadRoutes  from './routes/instagram-upload.routes';
import uploadStatusRoutes     from './routes/upload-status.routes';
import { remoteLibraryProxy } from './routes/remote-library-proxy.routes';
import { initWatcherFromConfig } from './watcher';
import { startPlugin } from './plugins';
import { LAB_MODE } from './config';
import { configRepo } from './db/config.repo';
import { flushHistoryOutbox } from './services/history-outbox.service';
import { historyOutboxRepo } from './db/history-outbox.repo';
import { fetchInstallationRole } from './services/installation-role.service';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));
// exposedHeaders: van en la respuesta de /thumbnail para que el frontend
// actualice duración/ratio sin esperar a recargar la lista — sin esto,
// fetch() no puede leer headers custom en respuestas cross-origin (dev server).
app.use(cors({ exposedHeaders: ['X-Duration-Seconds', 'X-Resolution'] }));

// Biblioteca remota: proxy de bytes crudo a la central, ANTES de express.json() --
// ver remote-library-proxy.routes.ts. Si el body-parser corriera primero, la subida
// TUS y el streaming de video llegarían con el body ya consumido/vacío.
app.use('/api/remote-library', remoteLibraryProxy);

app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'esse-local-backend', db: 'sqlite', environment: LAB_MODE ? 'lab' : 'local' });
});

app.use(authProxyRoutes);
app.use(localAdminRoutes);
app.use(youtubeUploadRoutes);
app.use(videoRoutes);
app.use(streamRoutes);
app.use(scanRoutes);
app.use(publishingStatusRoutes);
app.use(syncRoutes);
app.use(transcriptRoutes);
app.use(ideaRoutes);
app.use(gemsRoutes);
app.use(backupSyncRoutes);
app.use(tiktokUploadRoutes);
app.use(instagramUploadRoutes);
app.use(uploadStatusRoutes);

// Sirve el frontend estático si FRONTEND_DIST está configurado (modo empaquetado)
const frontendDist = process.env.FRONTEND_DIST;
if (frontendDist && fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// `exclusive: true` = SO_EXCLUSIVEADDRUSE en Windows. Sin esto, otro programa
// que arranque DESPUÉS puede sumarse al mismo puerto (Node bindea con
// SO_REUSEADDR y Windows lo permite) y quedarse con parte de las conexiones
// destinadas a esta app, sin ningún error visible de ninguno de los dos lados.
const httpServer = app.listen({ port: PORT, host: '0.0.0.0', exclusive: true });

// El arranque va en 'listening', NO como callback de app.listen(): Express 5
// registra ese mismo callback tambien como handler de 'error'
// (`server.once('error', done)` adentro de su app.listen). Con el puerto
// ocupado se ejecutaba igual -- logueaba "Local backend corriendo" y arrancaba
// el watcher, los plugins y el flush del outbox contra un server que nunca
// llego a escuchar. Verificado en Windows con el puerto 4000 tomado.
httpServer.on('listening', () => {
  console.log(`Local backend corriendo en http://0.0.0.0:${PORT}`);
  console.log(`Base de datos: SQLite (${LAB_MODE ? 'esse_lab.db -- MODO LABORATORIO' : 'esse_local.db'})`);

  // Hallazgo SYNC-02#1 (auditoría de sincronización 2026-08-30): el gate de
  // "solo la primaria mintea content_id" (Fase E,
  // docs/primary-install-corrected-plan-2026-08-14.md) ya se auto-corrige en
  // runtime -- pushFilesToCloud degrada y para el watcher apenas la central
  // contesta isPrimary:false (ver backup-sync.controller.ts) -- pero eso
  // corre recién en el próximo tick de sync. Si esta PC ya era secundaria
  // ANTES de este arranque (otra reclamó la primaria mientras esta estaba
  // cerrada), initWatcherFromConfig() la prendía igual y podía mintear
  // content_id nuevo para cualquier archivo ya presente en la carpeta vieja,
  // antes de que el primer push la degradara. Mismo token cacheado del
  // owner que ya usa el flush de arranque del outbox de historial más abajo.
  // Sin token o central caída: arranca el watcher igual que antes (fail
  // open, mismo criterio que requirePrimaryDevice -- no bloquear por un
  // problema de conectividad ajeno al rol real).
  const ownerTokenForRoleCheck = configRepo.get('owner_token');
  if (ownerTokenForRoleCheck) {
    fetchInstallationRole(`Bearer ${ownerTokenForRoleCheck}`).then(role => {
      if (role?.role === 'secondary') {
        console.log('[watcher] Esta instalación es secundaria -- no se inicia el watcher al arrancar (se retoma solo si vuelve a ser primaria).');
      } else {
        initWatcherFromConfig();
      }
    });
  } else {
    initWatcherFromConfig();
  }

  // Acceso Remoto funciona "por defecto" (como Acceso Local): si el plugin ya
  // está instalado, se arranca solo al iniciar — sin switch manual en la UI.
  // No-op seguro si no está instalado (startPlugin lo maneja sin tirar error).
  startPlugin('esse_remote_access');

  // Reintento de arranque para el outbox de historial (BUG-2026-08-15-07):
  // si quedó algo 'pending' de la sesión anterior (ej. se cerró la app con
  // la central caída a mitad de un push), esto lo reintenta apenas levanta
  // el server, sin esperar a la próxima publicación. Usa el token cacheado
  // del owner (ver local-admin.routes.ts::setOwner) -- best-effort, puede
  // estar vencido si pasaron más de 7 días sin loguearse; si falla, el
  // próximo flush disparado por una acción real con sesión fresca lo cubre
  // igual.
  const pendingAtStartup = historyOutboxRepo.countPending();
  if (pendingAtStartup > 0) {
    console.log(`[history-outbox] ${pendingAtStartup} evento(s) pendiente(s) de sesiones anteriores, reintentando...`);
    const cachedToken = configRepo.get('owner_token');
    if (cachedToken) {
      flushHistoryOutbox(`Bearer ${cachedToken}`).then(({ delivered, stillPending }) => {
        console.log(`[history-outbox] arranque: ${delivered} entregado(s), ${stillPending} siguen pendientes`);
      }).catch(err => console.warn('[history-outbox] flush de arranque falló:', err.message));
    }
  }
});

// Sin esto, un puerto ocupado terminaba en un evento 'error' sin manejar -> el
// proceso se caia con una excepcion no capturada. Adentro de Electron eso era
// peor todavia: la ventana se abria igual contra http://localhost:4000 y
// mostraba la interfaz DEL OTRO programa (o un error del navegador) sin
// ninguna explicacion.
httpServer.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;

  const motivo = error.code === 'EACCES'
    ? `el sistema no permite escuchar en el puerto ${PORT} (reservado o bloqueado)`
    : `el puerto ${PORT} ya esta ocupado por otro programa`;
  console.error(`[local-backend] No se pudo iniciar: ${motivo}.`);

  // Corriendo dentro de Electron, el main process escucha este evento y abre
  // la pantalla de "puerto ocupado" en vez de la ventana principal (ver
  // electron/src/main.ts). process.emit devuelve true si hubo alguien
  // escuchando; si no hay nadie (backend suelto con `npm run dev`), no queda
  // nada util por hacer y se corta con codigo de error.
  const manejadoPorElectron = (process as NodeJS.EventEmitter).emit('esse:port-conflict', PORT);
  if (!manejadoPorElectron) {
    console.error('[local-backend] Cerra el programa que lo esta usando y volve a intentar.');
    process.exit(1);
  }
});
