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
import gemsRoutes             from './routes/gems.routes';
import backupSyncRoutes       from './routes/backup-sync.routes';
import tiktokUploadRoutes     from './routes/tiktok-upload.routes';
import instagramUploadRoutes  from './routes/instagram-upload.routes';
import { initWatcherFromConfig } from './watcher';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json());

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
app.use(gemsRoutes);
app.use(backupSyncRoutes);
app.use(tiktokUploadRoutes);
app.use(instagramUploadRoutes);

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
});
