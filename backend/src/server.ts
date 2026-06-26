import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
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
import { apiRateLimit } from './middleware/rate-limit.middleware';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Seguridad: headers HTTP
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // necesario para servir streams/archivos al frontend
}));

// Seguridad: rate limit global
app.use('/api', apiRateLimit);

app.use(cors());
app.use(express.json());

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API corriendo en http://0.0.0.0:${PORT}`);
});

mongoose.connect(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    console.log('Conectado exitosamente a MongoDB Atlas');
  })
  .catch((err) => {
    console.error('Error de conexion a MongoDB:', err.message);
  });
