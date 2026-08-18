# Plan: optimizar conexiones y sincronización con la central — 2026-08-18

> Documento de **plan/investigación**, no de implementación. Ningún cambio de
> código de producción acompaña a este documento — es para que otra persona
> (u otra sesión) lo revise y decida qué encarar y en qué orden. Formato
> calcado de `docs/lan-library-auto-switch-design-2026-08-16.md`.

## Resumen ejecutivo

El sync local ↔ central (`useSyncOrchestrator` → `runSyncTick` → push/pull en
`local-backend`) funciona y ya tiene buen diseño a nivel de *disparadores*
(foco/visibilidad + fallback, cooldown compartido — ver
`frontend/src/hooks/useSyncOrchestrator.ts` y
`frontend/src/services/syncOrchestrator.ts`). El problema no es *cuándo* se
dispara, sino *cuánto pesa cada disparo*: cada tick manda/pide colecciones
**completas**, sin delta, en varios **round-trips secuenciales** contra la
central detrás del Cloudflare Tunnel. Para catálogos grandes esto es
transferencia y latencia desperdiciada en la mayoría de los ticks, donde en
realidad no cambió nada o cambió muy poco.

No hay nada roto — es una optimización, no un bugfix. El central ya protege
la integridad del dato del lado de escritura (diff por timestamp antes de
tocar Mongo); lo que falta optimizar es el lado de transporte.

## 1. Estado actual (con referencias exactas)

### 1.1 — Disparadores del tick (ya está bien, no tocar)

`frontend/src/hooks/useSyncOrchestrator.ts`:
- Dispara en mount (4s de delay), en `focus`/`visibilitychange`, y con un
  fallback ciego cada 20 min (`FALLBACK_INTERVAL_MS`).
- `beforeunload` hace un push best-effort con `keepalive`.
- `runSyncTick` (`frontend/src/services/syncOrchestrator.ts`) tiene un
  cooldown compartido de 5 min (`MIN_GAP_MS`) para que no importe cuántos
  disparadores caigan juntos, nunca golpea la central más seguido de lo
  necesario.

Este diseño está bien pensado y no es el foco de este plan.

### 1.2 — Push (`local-backend/src/controllers/backup-sync.controller.ts`)

`pushFilesToCloud` (línea 16):
- Lee y manda **el catálogo activo completo** (`limit: 50000`) en cada push,
  sin filtrar por lo que cambió desde el último push exitoso.
- Encadena, **secuencialmente** (`await` uno atrás del otro), 3 pushes más de
  colecciones completas:
  - `pushTranscriptsToCloud` (línea 144) — todas las transcripciones.
  - `pushPlatformVideosToCloud` (línea 118) — todos los platform_videos.
  - `pushConfigToCloud` (línea 159) — config + colas por plataforma.
- Total: **4 POSTs secuenciales** por push, cada uno cruzando el túnel.

### 1.3 — Pull (mismo archivo)

`pullFromCloud` (línea 213):
- `GET /api/backup/files?includeResolved=true` trae el catálogo cloud
  **entero** siempre, sin `since`/delta.
- Encadena secuencialmente `pullConfigFromCloud` (línea 381) y
  `pullPlatformVideosFromCloud` (línea 335) — 2 GETs más.
- Total: **3 GETs secuenciales** por pull.

### 1.4 — Pieza que ya existe y no se usa como gate

`backend/src/controllers/backup.controller.ts:1240`, `getBackupStatus`
(`GET /api/backup/status`) devuelve `{ total, lastSync }` con 2 queries
livianas (`countDocuments` + `findOne` ordenado). Es exactamente el tipo de
chequeo barato que haría falta antes de un pull completo — pero
`pullFromCloud` no lo llama; siempre hace el `GET /api/backup/files` pesado.
(Hay también `GET /api/backup/sync-status`, pero es distinto: da estado
por `contentIds` puntuales, no un "¿avanzó algo desde X?" global.)

### 1.5 — Orquestación total por tick

`runSyncTick` hace `push → pull → ensurePreload` secuencial, y cada uno de
esos pasos es a su vez secuencial internamente. Un solo tick "normal" (nada
cambió) puede terminar en **7-8 round-trips** por el túnel para confirmar que
no había nada que hacer.

### 1.6 — Contexto de rate limit (no es el problema hoy, pero da margen)

`backend/src/middleware/rate-limit.middleware.ts:24` — `apiRateLimit`:
120 req/min por IP en `/api`. Con el patrón actual, un tick normal ya consume
~7-8 de esos 120; si dos disparadores caen casi juntos (foco + visibilitychange)
el cooldown de 5 min lo evita, así que hoy no hay riesgo real de tocar el
límite. Se menciona solo como contexto: batchear reduce también esta presión,
no es la motivación principal.

### 1.7 — Restricción importante para cualquier propuesta de delta

`backend/src/controllers/backup.controller.ts` (`bulkUpsertBackupFiles`,
línea ~120), comentario en líneas 129-152: el flag `fullSync` que manda el
cliente se usa para **reconciliar** (archivar en la nube lo que ya no existe
en el local de la instalación primaria). Si el push dejara de mandar el
listado completo de archivos activos, la central perdería la forma de saber
qué videos borrar/archivar cuando el usuario elimina algo localmente.
**Cualquier propuesta de delta tiene que preservar esta reconciliación.**

## 2. Propuestas (orden sugerido de costo/beneficio)

### 2.1 — Gate barato antes del pull completo
**Qué:** antes de `GET /api/backup/files`, pegarle primero a
`GET /api/backup/status` y comparar `lastSync` contra `backup_last_pull`
(ya guardado en config local, línea 324). Si `lastSync` no avanzó, saltar el
pull completo.
**Costo:** bajo — el endpoint central ya existe, es solo cablear el local.
**Riesgo:** bajo. Único cuidado: `getBackupStatus` mide `lastSync` sobre
`BackupFileModel` únicamente — confirmar que cubre todos los casos que hoy
dispara un pull útil (o extenderlo a considerar también updates de
`platform_videos`/config si esos pueden avanzar sin tocar `BackupFileModel`).
**Impacto:** elimina el GET más pesado (`includeResolved=true`, catálogo
entero) en la mayoría de los ticks, que es el caso común (nada cambió desde
la última vez que la ventana tuvo foco).

### 2.2 — Paralelizar los sub-pushes/sub-pulls independientes
**Qué:** en `pushFilesToCloud`, cambiar los 3 `await` secuenciales
(transcripts, platform_videos, config) por `Promise.all` — no dependen entre
sí. Mismo criterio en `pullFromCloud` para `pullConfigFromCloud` +
`pullPlatformVideosFromCloud`.
**Costo:** bajo — cambio de control de flujo, sin tocar contratos de API.
**Riesgo:** bajo. Revisar que el manejo de errores actual (cada sub-push ya
es best-effort, con su propio `try/catch` que solo hace `console.warn`) siga
igual de tolerante en paralelo — no debería requerir cambios porque cada uno
ya está aislado.
**Impacto:** reduce la latencia de un push/pull "con cambios" de ~4-3
round-trips secuenciales a 1 (el de files) + 1 lote paralelo.

### 2.3 — Push delta (solo lo que cambió, con reconciliación intacta)
**Qué:** filtrar `files` a los que tengan `local_updated_at` más nuevo que el
último push exitoso, en vez de mandar los hasta 50.000 activos siempre. Para
no romper la reconciliación de `fullSync` (ver 1.7), mandar además un
`activeContentIds: string[]` liviano (solo IDs, no el registro completo) con
TODO lo que sigue activo localmente, para que la central pueda seguir
detectando qué archivar sin necesitar el payload completo de cada uno.
**Costo:** medio — toca el contrato entre `local-backend` y `backend`
(`POST /api/backup/files/bulk`) en los dos lados.
**Riesgo:** medio. Hay que decidir la ventana de seguridad para clock skew
(no confiar en "más nuevo que" al segundo exacto), y qué pasa si
`local_updated_at` nunca se seteó bien en un archivo viejo (fallback: tratarlo
como cambiado). Requiere test manual de la reconciliación de primaria/secundaria
antes de mergear (es la parte más sensible del sistema, ver
`docs/primary-install-corrected-plan-2026-08-14.md`).
**Impacto:** el más grande en bytes transferidos para cuentas con catálogos
grandes — pasa de O(catálogo) a O(cambios) en el caso común.

### 2.4 — Batchear las 4 colecciones en un solo endpoint
**Qué:** un `POST /api/backup/sync` que reciba
`{ files, transcripts, platformVideos, config, deviceId }` en un solo body
y lo procese server-side (puede seguir delegando internamente a la misma
lógica que ya existe por colección). Simétrico para el pull
(`GET /api/backup/sync` devolviendo las 4 colecciones juntas).
**Costo:** medio-alto — es el cambio de contrato más grande, y hay que
decidir si conviene versionar el endpoint viejo (¿lo siguen usando otros
clientes, ej. iOS/Android directo a la central?) o si solo lo consume
`local-backend`. **Confirmar antes de encarar esto:** si iOS/Android pegan
directo a algunos de estos endpoints de `/api/backup/*`, este cambio les
afecta a ellos también, no solo al desktop.
**Riesgo:** alto en superficie (toca varios controllers y su router), bajo
en lógica (no cambia reglas de negocio, solo el sobre que las transporta).
**Impacto:** el mayor en cantidad de round-trips — de 4+3 a 1+1 por tick con
cambios.

### 2.5 — (Fuera de alcance de este plan, mencionado para contexto)
Push-based invalidation desde la central (SSE/WS) para que dispositivos
secundarios se enteren al instante de cambios ajenos, en vez de esperar el
fallback de 20 min. Vale la pena solo si de verdad importa que multi-dispositivo
se sienta "en vivo" — no es una optimización de transporte como 2.1-2.4, es
un cambio de arquitectura (agregar un canal push a un sistema que hoy es
puramente request/response). Se deja fuera de este plan a propósito.

## 3. Orden recomendado

1. **2.1** (gate de status antes del pull) — bajo riesgo, ya está la pieza.
2. **2.2** (paralelizar sub-pushes/pulls) — bajo riesgo, cambio contenido.
3. **2.3** (push delta) — evaluar después de confirmar que 2.1+2.2 no alcanzan
   para el caso de catálogos grandes; requiere prueba manual de reconciliación
   primaria/secundaria.
4. **2.4** (batch en un endpoint) — solo si 2.1-2.3 no bajan lo suficiente la
   cantidad de round-trips, y después de confirmar que ningún otro cliente
   (iOS/Android) depende de los endpoints individuales.

## 4. Preguntas abiertas para quien revise

- ¿`getBackupStatus` (2.1) necesita ampliarse para reflejar también cambios en
  `platform_videos`/config, o alcanza con `BackupFileModel.updatedAt` porque
  en la práctica todo cambio relevante también toca un archivo?
- Para 2.3: ¿qué tan grandes son los catálogos reales de los usuarios premium
  hoy? Si son de decenas de archivos, el delta no vale la complejidad; si son
  cientos/miles, sí.
- Para 2.4: ¿algún cliente además de `local-backend` pega directo a
  `/api/backup/files`, `/api/backup/transcripts`, etc.? (Revisar
  `essenalytics-ios`/`essenalytics-android` antes de decidir el endpoint
  combinado.)
- ¿Vale la pena medir esto primero (logging de tamaño de payload/duración por
  tick) antes de invertir en 2.3/2.4, para confirmar que el cuello de botella
  real es el que este documento asume?
