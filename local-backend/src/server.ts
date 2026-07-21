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
  res.json({ ok: true, service: 'esse-local-backend', db: 'sqlite' });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Local backend corriendo en http://0.0.0.0:${PORT}`);
  console.log('Base de datos: SQLite (esse_local.db)');
  initWatcherFromConfig();

  // Acceso Remoto funciona "por defecto" (como Acceso Local): si el plugin ya
  // está instalado, se arranca solo al iniciar — sin switch manual en la UI.
  // No-op seguro si no está instalado (startPlugin lo maneja sin tirar error).
  startPlugin('esse_remote_access');
});
