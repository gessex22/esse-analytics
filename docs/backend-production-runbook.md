# Backend central: despliegue y operación

Este runbook cubre el backend central. El hardening de autenticación debe
desplegarse separado de cualquier migración de colecciones MongoDB.

## Configuración obligatoria

En producción el proceso se niega a arrancar si faltan valores críticos o si
los secretos tienen menos de 32 caracteres:

- `NODE_ENV=production`
- `MONGO_URI`
- `JWT_SECRET`, `CLIENT_REGISTER_KEY`, `OAUTH_STATE_SECRET`
- `OWNER_USERNAME`
- `FRONTEND_URL`, `API_URL`, `PUBLIC_API_ORIGIN`, `ALLOWED_ORIGINS`
- `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`
- `YOUTUBE_API_KEY`, `YOUTUBE_CHANNEL_ID`
- `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`, `META_REDIRECT_URI`
- `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`

`CLIENT_REGISTER_KEY` debe configurarse con el mismo valor en el backend
central y en el local-backend que representa a la aplicación instalada. No se
debe incluir ningún secreto en la imagen, el repositorio o los logs.

## Build y despliegue

El artefacto de producción es JavaScript compilado; no requiere `tsx`,
TypeScript ni otras dependencias de desarrollo en runtime.

```sh
cd backend
npm ci
npm run typecheck
npm test
npm run build
npm ci --omit=dev
NODE_ENV=production node dist/server.js
```

También existe una imagen reproducible, construida usando `backend/` como
contexto:

```sh
docker build -t esse-backend:VERSION backend
docker run --env-file /ruta/segura/backend.env -p 4000:4000 \
  -v esse-backend-data:/data esse-backend:VERSION
```

Antes de promover, probar la imagen en staging y verificar login, registro
desde la aplicación instalada, los tres callbacks OAuth y Biblioteca remota.

## Health, readiness y apagado

- `GET /api/health`: liveness del proceso.
- `GET /api/ready`: responde 200 solo con MongoDB conectado; de lo contrario
  responde 503.
- `SIGTERM`/`SIGINT`: dejan de aceptar conexiones, esperan las solicitudes en
  curso, cierran MongoDB y terminan. Hay un límite de seguridad de 10 segundos.

Los logs HTTP son JSON e incluyen `requestId`, método, plantilla de endpoint,
status y latencia. Nunca se deben agregar JWT, tokens OAuth, cuerpos de
petición, secretos o rutas físicas completas.

Alertas mínimas recomendadas:

- tres fallos consecutivos de `/api/ready`;
- tasa de 5xx mayor al 2% durante cinco minutos;
- latencia p95 mayor a dos segundos durante diez minutos;
- evento `mongo_connection_failed`, `uncaught_exception`,
  `unhandled_rejection` o `remote_library_retention_failed`;
- menos de 15% de espacio libre en el volumen de Biblioteca remota.

## Backup y restauración

MongoDB y los bytes de Biblioteca remota forman un único respaldo operativo.
El endpoint funcional de backup de los clientes no reemplaza este respaldo.

1. Usar un snapshot administrado de MongoDB o `mongodump --archive --gzip`.
2. Crear un snapshot del volumen indicado por `CENTRAL_REMOTE_LIBRARY_DIR`.
3. Para consistencia estricta, detener brevemente escrituras/subidas mientras
   se toman ambos snapshots, o usar snapshots coordinados del proveedor.
4. Cifrar, versionar y guardar las copias fuera del host del servicio.
5. Conservar y probar la política de retención definida por operación.

Ensayo de restauración:

1. Restaurar MongoDB en una base de staging aislada.
2. Restaurar el volumen en una ruta aislada con permisos del usuario runtime.
3. Arrancar la misma versión de la imagen con esas ubicaciones.
4. Verificar `/api/ready`, login, catálogo, streaming, miniaturas, historial y
   una muestra de archivos de Biblioteca remota.
5. Registrar fecha, versión, conteos y resultado del ensayo. No considerar un
   backup válido hasta que una restauración haya pasado.

## Rotación y revocación

- Cambiar `JWT_SECRET` invalida todos los JWT inmediatamente.
- Cambiar `OAUTH_STATE_SECRET` invalida solo autorizaciones OAuth iniciadas en
  los últimos diez minutos; no elimina tokens ya conectados.
- Cambios de contraseña, baja de cuenta, tier o almacenamiento incrementan
  `authVersion`, por lo que los JWT anteriores dejan de servir.
- La baja de cuenta también elimina sus tokens OAuth almacenados.
