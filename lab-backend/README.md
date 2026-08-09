# esse-lab-backend — Backend de Laboratorio

Servidor mock **compartido** entre iOS, Android y Electron para probar las
mismas funcionalidades sin tocar YouTube/Instagram/TikTok reales ni la
central de producción. Ver también `content-automation-dashboard/CLAUDE.md`
(arquitectura general) y `UIEssePanel/CLAUDE.md` (mapa de los 3 repos).

## Por qué es un paquete separado (no un flag dentro de `backend/`)

Para que sea **estructuralmente imposible** que el Laboratorio toque datos
reales:

- Store propio en `lab-data/lab.json` (un solo archivo JSON) -- nunca Mongo
  Atlas ni `esse_local.db`. Resetear el Laboratorio es borrar/vaciar ese
  archivo (`POST /api/lab/reset`).
- JWT propio, con secreto **distinto** al de `backend/`/`local-backend/`
  (`LAB_JWT_SECRET`, default en `.env.example`) -- un token del Laboratorio
  nunca valida contra la central real, ni viceversa.
- El proceso se **niega a arrancar** sin `ESSENALYTICS_LAB_MODE=1` (ver
  `src/server.ts`). No hay ningún otro interruptor.
- Nunca llama a `googleapis.com`/`graph.facebook.com`/`open.tiktokapis.com`
  -- los "uploaders" son simulaciones 100% en memoria (`publish-jobs.service.ts`).

## Cómo arrancarlo

```bash
cd lab-backend
npm install
cp .env.example .env
npm run dev          # tsx watch, puerto 5055 por default
```

Chequeo rápido:

```bash
curl http://localhost:5055/api/health
# {"ok":true,"environment":"lab","service":"esse-lab-backend"}
```

Panel de administración (crear/editar usuarios mock, aplicar escenarios, ver
publish jobs en curso): **http://localhost:5055/lab-admin/**

Para que teléfonos físicos en la misma Wi-Fi lo alcancen, usá la IP LAN de la
máquina que lo corre (ej. `http://192.168.1.50:5055`) en el selector de
servidor de cada app -- `localhost` solo funciona desde simuladores/Electron
en la misma máquina.

## Alcance (qué cubre y qué NO)

Cubre, con el mismo contrato de rutas que ya usan los clientes reales:

- Auth completo (`/api/auth/*`): registro, login, `me`, tema, link-install,
  administración de usuarios (tier/nube/baja) para el owner.
- Calendario (`/api/sync/calendar-config*`).
- Estadísticas (`/api/sync/group-stats`, `/api/sync/file-stats`).
- Historial (`/api/sync/history`, alias `/api/sync/record-publish`).
- Estado de publicación (`/api/publishing-status*`).
- Conexión por plataforma con el MISMO contrato que la central real (no un
  shape inventado): `GET /api/{platform}/{channel-info|account-info|
  creator-info}` (devuelve `{name,customUrl}` YouTube / `{name,username}`
  Instagram / `{nickname,username,privacyOptions,...}` TikTok -- igual que
  `backend/src/controllers/*-upload.controller.ts`), `GET /api/{platform}/
  auth/status` (`{connected: boolean}` o `401 NO_AUTH` si venció), `GET
  /api/{platform}/auth/url` (simula el handshake OAuth completo: conecta al
  usuario en el momento y devuelve `{url}` con `?{platform}_auth=success` ya
  puesto -- el botón "Conectar" de la UI real funciona sin ningún cambio del
  lado del cliente), `DELETE /api/{platform}/auth` (revoke), `GET
  /api/{platform}/token` (access_token mock).
- Uploaders mock por plataforma (`POST /api/{platform}/upload`) con progreso,
  éxito, fallo recuperable, token vencido, cancelación e interrupción/reintento
  -- ver `src/controllers/publish-jobs.service.ts`.
- Herramienta de Laboratorio (`/api/lab/*`): escenarios predefinidos, CRUD de
  usuarios mock (incluye `connections` por plataforma -- también editable
  fila por fila desde el panel), reset, listado/cancelación/reintento de
  publish jobs.

**Deliberadamente fuera de alcance** (funciones de reconciliación avanzada de
la central real, no necesarias para probar login/roles/tiers/calendario/
historial/publicación en el Laboratorio): cross-match entre plataformas,
cola de revisión manual (`/api/sync/review`), `platform-recent` en vivo,
sincronización completa de biblioteca/backup (`/api/backup/*`), Biblioteca
remota con bytes reales (`/api/remote-library`). Si algún flujo de iOS/Android
llama a una de estas rutas contra el Laboratorio, no está implementada
(404) -- deliberado, documentado acá antes que silenciosamente mal simulado.

`POST /api/{platform}/auth/connect` sigue existiendo como atajo sin
equivalente real (setea la conexión directo, sin el paso intermedio de
`auth/url`) -- útil para scripts/tests que no quieren simular el redirect.

## Escenarios predefinidos

`GET /api/lab/scenarios` los lista; `POST /api/lab/scenarios/:key/apply` con
`{ "username": "...", "password": "..." }` crea (o reemplaza) ese usuario con
los datos ya sembrados. Ver `src/data/scenarios.ts` para el detalle exacto de
cada uno: `owner_premium`, `editor_free`, `cloud_user`, `expired_connection`,
`publish_failed`, `publish_slow`, `publish_interrupted`, `empty_account`,
`account_with_data`.

## Simular publicaciones a mano (sin aplicar un escenario de publish_*)

```bash
# archivo YA debe pertenecer al catálogo del usuario (los escenarios lo siembran)
curl -X POST http://localhost:5055/api/instagram/upload \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"fileName":"laboratorio-video-1.mp4","mode":"fail"}'
# mode: success (default) | fail | slow | interrupted | token_expired

# progreso / resultado:
curl http://localhost:5055/api/lab/publish-jobs/$JOBID

# reintento (solo si retryable=true):
curl -X POST http://localhost:5055/api/lab/publish-jobs/$JOBID/retry
```

Un job creado por cualquier dispositivo es visible desde los otros (mismo
store compartido) -- así se prueba que "una publicación simulada desde iOS se
refleja en Android/Electron tras actualizar".

## Próximas fases (ver tasks del repo)

- `local-backend` en modo Laboratorio: SQLite separada + uploaders mock +
  proxy hacia este backend en vez de a la central real.
- Electron: `npm run dev:lab`, banner "Laboratorio · Datos simulados".
- Android/iOS: preset "Laboratorio" en Ajustes (solo builds debug) + uploaders
  mock que hablan contra este mismo contrato.
