import './load-env';   // ⚠️ DEBE ir primero: carga .env antes de que otros módulos lean process.env
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import videoRouter from './routes/video.routes';
import streamRouter from './routes/stream.routes';
import ideaRoutes from './routes/idearoutes';
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

const app = express();
const PORT = process.env.PORT || 4000;

// Detrás de Cloudflare Tunnel — confiar en el proxy para que rate-limit lea la IP real
app.set('trust proxy', 1);

// Seguridad: headers HTTP
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // necesario para servir streams/archivos al frontend
}));

// Seguridad: rate limit global
app.use('/api', apiRateLimit);

// Seguridad: CORS restringido a orígenes conocidos.
// Las peticiones server-to-server (local-backend proxy, curl, apps) no llevan Origin → se permiten.
// El navegador solo nos llama desde la web pública.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://esse-analytics.com,https://www.esse-analytics.com')
  .split(',').map(s => s.trim()).filter(Boolean);

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
    mongoState: mongoose.connection.readyState,
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

const REMOTE_LIBRARY_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1h

function scheduleRemoteLibraryRetentionSweep(): void {
  runRemoteLibraryRetentionSweep()
    .then(r => console.log(`[remote-library-retention] usuarios=${r.usersScanned} protegidos=${r.protectedCount} liberados=${r.evicted} únicaCopia=${r.keptSoleCopy} endurecidos=${r.hardened}`))
    .catch(err => console.error('[remote-library-retention] error:', err.message));
  setTimeout(scheduleRemoteLibraryRetentionSweep, REMOTE_LIBRARY_RETENTION_INTERVAL_MS);
}

mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    console.log('Conectado exitosamente a MongoDB Atlas');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`API corriendo en http://0.0.0.0:${PORT}`);
    });
    // Almacenamiento dinámico de Biblioteca remota: libera bytes de video que
    // ya no son "el próximo a publicar" de ninguna plataforma (ver
    // remote-library-retention.service.ts). Corre una vez al arrancar y
    // después cada 1h -- no hace falta disparo inmediato por evento porque
    // total, si un video queda de más un rato, no pasa nada grave.
    scheduleRemoteLibraryRetentionSweep();
  })
  .catch((err) => {
    console.error('Error de conexion a MongoDB:', err.message);
    process.exit(1);
  });
