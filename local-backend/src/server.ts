import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import videoRoutes            from './routes/video.routes';
import streamRoutes           from './routes/stream.routes';
import scanRoutes             from './routes/scan.routes';
import publishingStatusRoutes from './routes/publishing-status.routes';
import syncRoutes             from './routes/sync.routes';
import authProxyRoutes        from './routes/auth-proxy.routes';
import localAdminRoutes       from './routes/local-admin.routes';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'esse-local-backend', mongoState: mongoose.connection.readyState });
});

app.use(authProxyRoutes);     // auth → central
app.use(localAdminRoutes);   // wipe y health local
app.use(videoRoutes);
app.use(streamRoutes);
app.use(scanRoutes);
app.use(publishingStatusRoutes);
app.use(syncRoutes);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/esse_local';

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log('MongoDB local conectado:', MONGO_URI))
  .catch(err => console.error('Error MongoDB:', err.message));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Local backend corriendo en http://0.0.0.0:${PORT}`);
});
