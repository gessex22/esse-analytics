import './load-env';   // ⚠️ DEBE ir primero: carga .env antes de que otros módulos lean process.env
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import videoRouter from './routes/video.routes';
import streamRouter from './routes/stream.routes';
import ideaRoutes from './routes/ideaRoutes';
import authRoutes from './routes/auth.routes';
import syncRoutes from './routes/sync.routes';
import publishingStatusRouter from './routes/publishing-status.routes';
import youtubeUploadRouter    from './routes/youtube-upload.routes';
import instagramUploadRouter from './routes/instagram-upload.routes';
import tiktokUploadRouter    from './routes/tiktok-upload.routes';
import scanRouter            from './routes/scan.routes';
import componentsRouter      from './routes/components.routes';
import backupRouter          from './routes/backup.routes';
import remoteLibraryRouter   from './routes/remote-library.routes';
import auditRouter           from './routes/audit.routes';
import { apiRateLimit } from './middleware/rate-limit.middleware';
import { runRemoteLibraryRetentionSweep } from './services/remote-library-retention.service';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { requestContext, sanitizeProductionErrors } from './middleware/request.middleware';
import { logger } from './utils/logger';

const app = express();
const PORT = env.PORT;

// Detrás de Cloudflare Tunnel — confiar en el proxy para que rate-limit lea la IP real
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(requestContext);
app.use(sanitizeProductionErrors);

// Seguridad: headers HTTP
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // necesario para servir streams/archivos al frontend
}));

// Seguridad: rate limit global
app.use('/api', apiRateLimit);

// Seguridad: CORS restringido a orígenes conocidos.
// Las peticiones server-to-server (local-backend proxy, curl, apps) no llevan Origin → se permiten.
// El navegador solo nos llama desde la web pública.
const ALLOWED_ORIGINS = env.ALLOWED_ORIGINS;

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);             // server-to-server / apps nativas
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido por CORS'));
  },
  // Headers de respuesta del protocolo TUS (Biblioteca remota) -- sin esto el
  // navegador los recibe pero el JS del cliente (tus-js-client) no puede
  // leerlos cross-origin, y la subida resumable no encuentra dónde seguir.
  exposedHeaders: ['Location', 'Upload-Offset', 'Upload-Length', 'Tus-Version', 'Tus-Resumable', 'Tus-Max-Size', 'Tus-Extension'],
}));
app.use(express.json({ limit: '10mb' }));
// Meta envía el signed_request de eliminación como application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'content-automation-dashboard-api',
  });
});

app.get('/api/ready', (_req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  res.status(mongoReady ? 200 : 503).json({
    ok: mongoReady,
    dependencies: { mongo: mongoReady ? 'ready' : 'unavailable' },
  });
});

app.use(authRoutes);
app.use(syncRoutes);
app.use(videoRouter);
app.use(streamRouter);
app.use('/api/ideas-centrales', ideaRoutes);
app.use(publishingStatusRouter);
app.use(youtubeUploadRouter);
app.use(instagramUploadRouter);
app.use(tiktokUploadRouter);
app.use(scanRouter);
app.use(componentsRouter);
app.use(backupRouter);
app.use(remoteLibraryRouter);
app.use(auditRouter);
app.use(notFoundHandler);
app.use(errorHandler);

const REMOTE_LIBRARY_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1h

let retentionTimer: NodeJS.Timeout | undefined;

function scheduleRemoteLibraryRetentionSweep(): void {
  runRemoteLibraryRetentionSweep()
    .then(r => logger.info('remote_library_retention', {
      usersScanned: r.usersScanned, protectedCount: r.protectedCount,
      evicted: r.evicted, keptSoleCopy: r.keptSoleCopy, hardened: r.hardened,
    }))
    .catch(err => logger.error('remote_library_retention_failed', {
      errorName: err instanceof Error ? err.name : 'UnknownError',
    }));
  retentionTimer = setTimeout(scheduleRemoteLibraryRetentionSweep, REMOTE_LIBRARY_RETENTION_INTERVAL_MS);
  retentionTimer.unref();
}

let httpServer: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { reason });
  if (retentionTimer) clearTimeout(retentionTimer);

  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  if (httpServer) await new Promise<void>(resolve => httpServer!.close(() => resolve()));
  await mongoose.disconnect().catch(() => undefined);
  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.once('SIGINT', () => void shutdown('SIGINT', 0));
process.once('uncaughtException', err => {
  logger.error('uncaught_exception', { errorName: err.name });
  void shutdown('uncaughtException', 1);
});
process.once('unhandledRejection', reason => {
  logger.error('unhandled_rejection', {
    errorName: reason instanceof Error ? reason.name : 'UnknownError',
  });
  void shutdown('unhandledRejection', 1);
});

mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    logger.info('mongo_connected');
    httpServer = app.listen(PORT, '0.0.0.0', () => {
      logger.info('server_listening', { port: PORT, environment: env.NODE_ENV });
    });
    // Almacenamiento dinámico de Biblioteca remota: libera bytes de video que
    // ya no son "el próximo a publicar" de ninguna plataforma (ver
    // remote-library-retention.service.ts). Corre una vez al arrancar y
    // después cada 1h -- no hace falta disparo inmediato por evento porque
    // total, si un video queda de más un rato, no pasa nada grave.
    scheduleRemoteLibraryRetentionSweep();
  })
  .catch((err) => {
    logger.error('mongo_connection_failed', {
      errorName: err instanceof Error ? err.name : 'UnknownError',
    });
    void shutdown('mongo_connection_failed', 1);
  });
