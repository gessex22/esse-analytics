// Punto de entrada del backend de Laboratorio. Ver README.md para el resumen
// de arquitectura completo -- acá solo el arranque.
import { LAB_MODE, PORT, ALLOWED_ORIGINS } from './config';

// Gate explícito y temprano: sin ESSENALYTICS_LAB_MODE=1 el proceso ni levanta
// Express. No hay ningún otro camino para activar el Laboratorio (nada de UI,
// nada de default "on") -- a propósito, para que sea estructuralmente
// imposible dejarlo prendido por accidente en una máquina que no es de dev.
if (!LAB_MODE) {
  console.error(
    '\n[lab-backend] ESSENALYTICS_LAB_MODE=1 no está seteada -- este servidor ' +
    'existe únicamente para el entorno de Laboratorio y se niega a arrancar ' +
    'sin ese flag explícito. Copiá .env.example a .env (ya lo trae en 1) o ' +
    'corré: ESSENALYTICS_LAB_MODE=1 npm run dev\n',
  );
  process.exit(1);
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { loadDb, dbPath } from './store/db';
import authRoutes from './routes/auth.routes';
import syncRoutes from './routes/sync.routes';
import publishingStatusRoutes from './routes/publishing-status.routes';
import platformRoutes from './routes/platform.routes';
import labRoutes from './routes/lab.routes';
import { apiRateLimit } from './middleware/rate-limit.middleware';

loadDb();

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(ALLOWED_ORIGINS.length ? { origin: ALLOWED_ORIGINS } : {}));
app.use(express.json({ limit: '5mb' }));

// Mismo criterio que backend/src/server.ts: rate limit general sobre TODO
// /api (login/registro tienen además su propio límite más estricto, ver
// auth.routes.ts). El Laboratorio corre expuesto en la LAN sin ninguna otra
// protección -- sin esto, cualquiera en la misma Wi-Fi podría probar
// contraseñas sin freno contra los usuarios mock.
app.use('/api', apiRateLimit);

// El campo `environment: 'lab'` es la señal inequívoca que los clientes (ver
// iOS CentralAPI / Android SettingsViewModel, fases 2 y 3) usan para decidir
// si activan mocks -- SOLO si este campo dice 'lab', nunca por heurística de
// URL/puerto.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, environment: 'lab', service: 'esse-lab-backend' });
});

app.use(authRoutes);
app.use(syncRoutes);
app.use(publishingStatusRoutes);
app.use(platformRoutes);
app.use(labRoutes);

// Panel de administración del Laboratorio -- ver public/admin.html.
app.use('/lab-admin', express.static(path.join(__dirname, '..', 'public')));
app.get('/', (_req, res) => res.redirect('/lab-admin/'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[lab-backend] Laboratorio corriendo en http://0.0.0.0:${PORT}  (ESSENALYTICS_LAB_MODE=1)`);
  console.log(`[lab-backend] Store: ${dbPath()}`);
  console.log(`[lab-backend] Panel admin: http://localhost:${PORT}/lab-admin/`);
});
