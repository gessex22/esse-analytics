# Registro de bugs

Bitácora compartida para que cualquier agente pueda continuar una investigación
sin reconstruir el contexto. Agregar una entrada por incidente; no borrar las
resueltas. Los bugs que involucren contratos compartidos deben además seguir
`../LAB_FEATURE_PROMPT.md`.

## Cómo registrar un bug

Usar el siguiente formato:

```md
## BUG-AAAA-MM-DD-NN — título breve

- Estado: `abierto` | `en investigación` | `corregido` | `verificado` | `bloqueado`
- Reportado: YYYY-MM-DD
- Plataformas: iOS | Android | Web/Electron | Central | Laboratorio
- Severidad: baja | media | alta | crítica
- Reportado por: usuario | agente | monitoreo

### Síntoma y pasos para reproducir

### Resultado esperado / resultado observado

### Investigación

### Corrección

### Verificación y pendiente

### Historial
- YYYY-MM-DD — autor: cambio o hallazgo.
```

## Incidentes

## BUG-2026-08-15-06 — Web (modo remoto) sigue mostrando "clip - enemigos tiene.mp4" como último publicado pese a que la central tiene el dato correcto verificado

- Estado: `en investigación` — **sin resolver, handoff para otra sesión**.
- Reportado: 2026-08-15
- Plataformas: Web (esse-analytics.com, modo remoto). iOS ya tiene su fix
  aparte (ver BUG-2026-08-15-05, historial 2026-08-15), pendiente de
  build/instalación real en el dispositivo -- no confundir los dos.
- Severidad: alta (tarjeta principal del Dashboard)
- Reportado por: usuario

### Síntoma

En `esse-analytics.com` (modo remoto, banner amarillo "Modo remoto —
funciones limitadas" visible), la tarjeta "Último video publicado" muestra
**"clip - enemigos tiene.mp4"** (Instagram, 153 vistas / 3 likes / 1
comentario, "Publicado sáb, 25 abr") -- screenshot real adjuntado por el
usuario en el chat de esta sesión. El video correcto según el historial ya
arreglado en Mongo es **"final - peores windows.mp4"** (Instagram, hoy
2026-08-15 11:11).

Los números mostrados (153/3/1) son datos REALES y correctos -- son las
métricas reales de "enemigos tiene" (correctas, arregladas hoy mismo con la
fecha real de la API de Instagram, ver historial de BUG-2026-08-15-02/04).
El problema no es que el dato esté mal: es que se muestra el video
equivocado, con sus propios datos correctos.

### Todo lo que YA se descartó, con evidencia (no repetir esta investigación)

1. **No es un problema de datos en Mongo.** Verificado repetidas veces,
   la última justo antes de este reporte: `UploadHistoryModel` para
   `userId=6a3794fb81e6fb54aca72461` (username `esse`, confirmado -- es el
   único user con ese username, sin ambigüedad) tiene 150 registros, el
   `.find({userId}).sort({publishedAt:-1, createdAt:-1}).limit(5)` (query
   EXACTA de `getUploadHistory`, `backend/src/controllers/backup.controller.ts:1140`)
   devuelve "final - peores windows.mp4" en el puesto #1. El registro de
   "enemigos tiene" en esa misma colección tiene su `publishedAt` correcto
   en abril (`2026-04-26T04:34:20Z`), no fue tocado por nada después del
   backfill.
2. **No es un problema del proceso corriendo.** La central real corre en
   una Mac (`macgessemberg22` por SSH, ver [[ios_ssh_build]] para el acceso),
   proceso `tsx watch src/server.ts` en
   `/Volumes/Almacenamiento externo samsung/proyecto/esse-analytics/backend/`
   (⚠️ checkout DISTINTO a `/Users/gessemberg/builds/content-automation-dashboard`,
   que existe pero está vacío/sin usar -- no confundir los dos si se vuelve a
   tocar esa Mac). Confirmado: mismo remote git (`gessex22/esse-analytics`),
   `HEAD` en el último commit pusheado hoy, `git status` limpio. Mismo
   `MONGO_URI` (`cluster0.elkjyvb.mongodb.net/renders_manager`) que se usó en
   todos los scripts de verificación/backfill de esta sesión.
3. **El túnel está vivo y respondiendo.** `curl https://api.esse-analytics.com/api/health`
   → `{"ok":true,"mongoState":1}`, probado en el momento de escribir esto.
4. **El frontend apunta a la URL correcta.** `frontend/src/config.ts::API_BASE`
   = `https://api.esse-analytics.com` cuando `isCloudflarePages` (el caso de
   la web pública) -- mismo endpoint que se verificó vivo en el punto 3.
5. **No es caché del navegador.** Probado por el usuario en ventana de
   incógnito (sin extensiones, sin caché, sin Service Worker previo) -- mismo
   resultado.
6. **No es un problema de `confirmLink`/`applyPlatformPublish` para ESTE
   video puntual.** Ambos archivos ("enemigos tiene" y "peores windows")
   tienen sus registros correctos y completos en `PlatformVideoModel` y
   `FileModel` -- ya verificado en detalle en incidentes anteriores de hoy.
7. **El código de `getUploadHistory` (central) no se tocó en ningún fix de
   hoy** -- siempre fue `.find({userId, platform?}).sort({publishedAt:-1,
   createdAt:-1})`, sin filtros adicionales, confirmado leyendo el archivo
   completo dos veces.
8. **El código de `DashboardView.tsx` (frontend web) tampoco se tocó hoy** --
   se leyó completo (`load()`, el cálculo de `item`/`matchedHistory`/
   `fallbackStats`) y la lógica se ve correcta: sí resetea `fallbackStats`
   correctamente a diferencia del bug que SÍ se encontró y arregló en iOS
   (ver más abajo), no debería tener el mismo problema.

### Lo que SÍ se encontró y arregló en el camino (relacionado pero no la causa de este síntoma en la web)

- **iOS**: `DashboardView.swift::latestForDisplay` tenía un fallback que
  devolvía `fallbackStats` viejo sin validar que coincidiera con el
  historial actual -- corregido y pusheado (`essenalytics-ios` commit
  `1a7699b`), build real verificado, **pero nunca instalado en el
  dispositivo del usuario** (falta abrir Xcode y correr). Si se retoma este
  bug, primero confirmar que el usuario ya instaló ese build antes de asumir
  que el problema de iOS sigue vivo.
- **`local-backend` no tenía `POST /api/sync/history`** -- agregado hoy
  (`content-automation-dashboard` commit `e3b74eb`), cierra el gap para
  publicaciones futuras hechas desde el celular en modo "PC local", pero
  **no es la causa de este síntoma** (el síntoma es en modo remoto/web,
  hablando con la central directo, no con `local-backend`).
- **`UploadHistoryModel` estaba vacío para toda la cuenta** -- backfileado
  (150 registros, ver BUG-2026-08-15-05). Confirmado que sigue así de bien
  varias veces durante esta misma investigación.

### Hipótesis sin probar (por dónde seguir)

1. **¿Hay una segunda instancia de la central corriendo en algún lado** (otro
   proceso, otra Mac, un deploy en la nube tipo Render/Fly.io/Railway) que
   también resuelva `api.esse-analytics.com` o que el Cloudflare Tunnel esté
   apuntando a un target distinto del proceso que se inspeccionó por SSH?
   Vale la pena revisar la config del túnel (`cloudflared`, en la Mac) para
   confirmar que apunta al puerto/proceso correcto, no asumirlo.
2. **¿El navegador está resolviendo `api.esse-analytics.com` a una IP
   vieja/cacheada por DNS?** Un `nslookup`/`dig` desde la máquina del usuario
   (no desde acá) descartaría esto.
3. **¿Hay algo en el response real (no solo en Mongo) que difiera?** Sería
   ideal capturar la respuesta real de
   `GET https://api.esse-analytics.com/api/sync/history?limit=1` con el JWT
   real del usuario (Network tab del navegador, o `curl` con el token
   copiado de ahí) -- esto no se pudo hacer desde esta sesión por no tener
   credenciales, y es probablemente el paso más directo para partir en dos
   la investigación: si el response YA trae "enemigos tiene", el problema es
   100% servidor (algo no visto en los puntos 1-8 de arriba); si trae
   "peores windows" pero la UI muestra "enemigos", el problema es 100%
   frontend (un bug no encontrado en la lectura de `DashboardView.tsx`).
4. Confirmar con el usuario si en algún momento **actualizó `esse_local.db`
   o corrió algo que pudiera haber generado un registro NUEVO de "enemigos"
   en Mongo con un `publishedAt` más reciente** después del último chequeo
   de esta sesión -- se verificó "ahora mismo" en el momento de escribir
   esto, pero el estado puede seguir cambiando si hay procesos automáticos
   corriendo.

### Historial
- 2026-08-15 — Claude: investigación extensa, causa NO encontrada pese a
  descartar sistemáticamente datos/proceso/túnel/config/caché/código
  conocido. Handoff a otra sesión con el punto 3 de las hipótesis (capturar
  el response real con curl+JWT) como paso más directo para continuar.

## BUG-2026-08-15-05 — Dashboard mostraba el video equivocado como "último publicado" (Historial vacío desde siempre)

- Estado: `corregido`; backfill aplicado, pendiente verificar Dashboard en los 3 clientes.
- Reportado: 2026-08-15
- Plataformas: Central, iOS, Android, Web, Local-backend (PC local)
- Severidad: alta (afecta la tarjeta principal del Dashboard en todos los clientes)
- Reportado por: usuario

### Síntoma y pasos para reproducir

El Dashboard ("Último video publicado") mostraba un video que no era el más
recientemente publicado -- confirmado con "final - peores windows.mp4"
apareciendo como "último" en vez del real más reciente.

### Investigación

`UploadHistoryModel` (central) tenía **0 documentos en toda la cuenta**,
pese a tener 150 `PlatformVideoModel` reales con links/métricas. Causa: la
mayoría de las publicaciones de esta cuenta se resolvieron con "Editar
links"/match manual (`confirmLink` en `sync.controller.ts`), que actualiza
`PlatformVideoModel`/`FileModel` vía `applyPlatformPublish` pero **nunca
escribía en `UploadHistoryModel`** -- a diferencia de `recordUploadEvent`
(subida en vivo desde la app), que sí lo hace. Con el historial siempre
vacío, el Dashboard (iOS/Android/web) cae a su fallback documentado ("sin
historial, mostrar el primero de `group-stats`", ordenado por
`fecha_creacion` -- la fecha de CREACIÓN del archivo, no de publicación),
mostrando casi cualquier cosa menos lo realmente más reciente.

De paso, investigando por qué un video publicado desde el celular en modo
"PC local" tampoco aparecía: **`local-backend` no tenía ningún `POST
/api/sync/history` ni `/api/sync/record-publish`** -- sin ese endpoint, un
cliente apuntando a la LAN de la PC en vez de a la central no tiene dónde
reportar una publicación (404 mudo, best-effort, no rompe la subida en sí
pero tampoco queda registrada en ningún lado).

### Corrección

1. **Backfill** (`backend`, corrido a mano en Mongo): un `UploadHistoryModel`
   por cada `PlatformVideoModel` real+vinculado existente (150 registros
   creados), usando sus propios `publishedAt`/`platformUrl`/etc. Corrige el
   síntoma actual de inmediato en todos los clientes que leen de la central.
2. **`confirmLink`** (`backend/src/controllers/sync.controller.ts`) ahora
   también escribe en `UploadHistoryModel` (mismo patrón `upsert` que
   `recordUploadEvent`), para que esto no vuelva a pasar con futuros matches
   manuales.
3. **`recordUploadEvent` nuevo en `local-backend`**
   (`src/controllers/sync.controller.ts` + `src/routes/sync.routes.ts`,
   `POST /api/sync/history` y alias `/api/sync/record-publish`) -- mismo
   contrato que la central, pero escribe en la SQLite de la PC
   (`platform_videos` + `files.platforms`), resolviendo el archivo por
   `content_id`/`file_name` ya que el celular no conoce el id local.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/` (27) y `local-backend/` (48): mismo
  conteo de errores preexistentes en ambos, ninguno nuevo.
- Backfill verificado: 150/150 insertados, top 3 por `publishedAt` desc ya
  muestra el orden real correcto.
- Pendiente: confirmar visualmente que el Dashboard de iOS/Android/web ya
  muestra el video correcto tras el backfill, y probar el flujo completo
  (celular en modo PC local publicando algo nuevo) para confirmar que
  `local-backend` ahora sí lo registra.

### Historial
- 2026-08-15 — Claude: causa raíz encontrada (historial global vacío, no un
  problema puntual de "PC local"), backfill aplicado, 2 fixes de código para
  que no vuelva a pasar.
- 2026-08-15 — Claude: tras el backfill, el usuario reportó que el Dashboard
  de iOS seguía mostrando "clip - enemigos tiene.mp4" en vez del correcto.
  Causa DISTINTA, del lado cliente: `DashboardView.swift::latestForDisplay`
  tenía un segundo `if let fallbackStats { return fallbackStats }` SIN el
  chequeo `fallbackMatchesLatestHistory` (a diferencia del primero) --
  `fallbackStats` es deliberadamente persistente entre refreshes, así que
  cuando `latest` fallaba en encontrar el archivo del historial YA correcto
  dentro de `items` (afuera del top-5 de `group-stats` por `fecha_creacion`
  vieja), esa línea servía sin darse cuenta datos STALE de un video previo
  completamente distinto. Corregido: se saca esa línea, cae al placeholder
  honesto (nombre + sin métricas) en vez de datos de otro video. Build real
  verificado (exit 0, 0 errores).

## BUG-2026-08-15-04 — Link resuelto a mano para una publicación vieja se guardaba con fecha "hoy"

- Estado: `corregido`; pendiente de verificación con un link real que no tenga registro local previo.
- Reportado: 2026-08-15
- Plataformas: Central (afecta a los 3 clientes que llaman a `applyPlatformPublish`)
- Severidad: media (rompe el orden "más reciente" de Estadísticas por plataforma, no las métricas en sí)
- Reportado por: usuario

### Síntoma y pasos para reproducir

Al resolver un link para un video que ya estaba publicado hace tiempo en una
plataforma pero nunca tuvo un `PlatformVideoModel`/registro local (badge
huérfano, mismo patrón que BUG-2026-08-15-02/03), el `publishedAt` guardado
quedaba en el momento en que se resolvió el link ("hoy"), no la fecha real de
publicación. Caso real: Instagram de "clip - enemigos tiene.mp4", publicado
el 25/04, resuelto hoy -- quedó con `publishedAt: 2026-08-15T10:40:20Z` hasta
que se corrigió a mano contra la API real de Instagram (`timestamp:
2026-04-26T04:34:20Z`).

### Investigación

`applyPlatformPublish` (`backend/src/controllers/backup.controller.ts`)
default a `new Date()` cuando el caller no manda `publishedAt`. Ya existía una
salvaguarda parcial en `local-backend/src/controllers/video.controller.ts::
setPlatformLink` (reusar `previousPublication.published_at` si existía un
registro local previo para ese archivo+plataforma) -- pero **solo cubre la
corrección de un link ya conocido localmente**, no la primera vez que se
resuelve un badge huérfano (no hay `previousPublication` de la cual sacar la
fecha). Ya había un incidente igual documentado en un comentario del código
mismo, fechado 2026-08-14, con TikTok -- ese fix solo tapó el síntoma en el
Calendario (omitiendo la fecha ahí cuando no hay una confiable), nunca
arregló la causa en `PlatformVideoModel`/`FileModel`.

### Corrección

Tres funciones nuevas, una por plataforma, que consultan la fecha real de
publicación directo a la API (todas best-effort, `null` si falla):
- `youtube.service.ts::getVideoPublishedAt(videoId)` -- reusa
  `getVideoDetails` (ya pedía `part=snippet`, que trae `publishedAt`).
- `instagram.service.ts::getMediaPublishedAt(userId, mediaId)` -- Graph API
  `fields=timestamp`.
- `tiktok.service.ts::getVideoPublishedAt(userId, videoId)` -- mismo
  `/video/query/` que `getVideoStatsByIds`, pidiendo `create_time`.

`applyPlatformPublish` ahora, cuando el caller no manda `publishedAt`, llama
a la función correspondiente (con el `platformId` ya resuelto a su forma
numérica/real, no el shortcode/publish_id crudo) antes de caer a `new
Date()`. Si la plataforma no responde (token vencido, red, video privado), se
comporta exactamente igual que antes -- nunca bloquea el link/badge por esto.

### Verificación y pendiente

- `npx tsc --noEmit`: mismo conteo de errores preexistentes que `main` (27),
  ninguno nuevo.
- Pendiente: probar con un link real (badge huérfano, plataforma conectada
  con token válido) y confirmar que `publishedAt` queda con la fecha real, no
  la de hoy.
- No cubre el caso donde la plataforma SÍ responde pero con datos
  incompletos/erróneos (ej. Graph API sin `timestamp` en la respuesta) --
  ahí sigue cayendo a `new Date()` como antes, mismo comportamiento previo al
  fix.

### Historial
- 2026-08-15 — Claude: encontrado en vivo (usuario probando el selector de
  servidor "PC local"), causa identificada, corregido con fetch best-effort a
  la API real de cada plataforma.

## BUG-2026-08-15-03 — Estado de publicación histórico sin enlace se interpreta distinto entre Nube y móviles

- Estado: `abierto`
- Reportado: 2026-08-15
- Plataformas: Central, Nube, iOS, Android
- Severidad: alta (un mismo video puede aparecer terminado en Android y disponible en iOS)
- Reportado por: usuario

### Planteamiento del problema

Los videos históricos, publicados antes de usar EsseAnalytics o publicados por
un canal externo, deben poder marcarse como publicados sin que el usuario tenga
que conseguir y registrar un enlace de cada plataforma. En esos casos el badge
es válido, pero no existe un `platformId`/URL desde el cual consultar métricas.

Actualmente `platforms` representa a la vez «publicado» y «publicado con una
identidad verificable». Biblioteca remota puede tener badges sin `platformLinks`,
y su estado puede diferir del catálogo central/backup. Los clientes interpretan
el resultado de forma distinta:

- Android oculta de Subir un video de Nube cuando las tres plataformas están
  resueltas por badges o descartes.
- iOS parte de su catálogo local y puede mostrarlo; al abrir el formulario
  incorpora después los badges de Nube.
- Métricas solo pueden obtenerse cuando existe un `PlatformVideo` con id nativo.

Ejemplo confirmado: `clip - enemigos tiene.mp4` figura con tres badges en Nube
sin enlaces, mientras el catálogo central conserva únicamente TikTok marcado,
YouTube descartado e Instagram pendiente. Por eso se oculta en Android pero
puede listarse en iOS con badges distintos.

### Resultado esperado

Una publicación histórica sin link sigue contando como publicada y resuelta
para la cola, pero se identifica explícitamente como tal. Todos los clientes
ven el mismo estado y no intentan solicitar métricas donde no existe una
identidad de plataforma.

### Solución propuesta

1. Definir por plataforma tres estados explícitos:
   - `confirmed`: publicación con `platformId` (y URL opcional); permite link y métricas.
   - `badge_only`: publicación histórica/manual sin ID ni URL; muestra «Sin enlace / métricas no disponibles».
   - `discarded`: plataforma descartada; no se publica ni se consulta.
2. Mantener `platforms` por compatibilidad como la lista de `confirmed` y
   `badge_only`, pero guardar la procedencia/estado explícito por plataforma
   (por ejemplo, `platformPublicationStates`). No inferir `confirmed` solo por
   la presencia del badge.
3. Hacer que Nube sea la fuente de verdad para un video con `contentId` y que
   el sync propague el estado completo, no una unión acumulativa de badges.
   La unión actual no puede corregir una marca histórica equivocada.
4. Android e iOS deben usar el mismo criterio de cola: tanto `confirmed` como
   `badge_only` y `discarded` son terminales; solo `pending` es publicable.
5. El Dashboard/Estadísticas solo solicitan métricas para `confirmed`. Para
   `badge_only` deben mostrar un estado claro en lugar de ceros o un error.
6. Migrar los registros existentes sin link a `badge_only`; conservar como
   `confirmed` únicamente los que tengan `platformLinks` o `PlatformVideo`
   verificable. Los casos donde las fuentes difieren requieren una revisión
   puntual antes de sobrescribir la decisión histórica del usuario.

### Verificación propuesta

1. Crear un video histórico con tres `badge_only`: debe desaparecer de la cola
   tanto en Android como en iOS y mostrar los tres badges sin métricas.
2. Crear un video con TikTok `confirmed`, YouTube `discarded` e Instagram
   pendiente: debe seguir disponible exclusivamente para Instagram en ambos
   móviles.
3. Publicar desde iOS, Android y Desktop: el resultado debe crear
   `confirmed` con ID y mantener el mismo estado en Nube y catálogo central.

### Historial

- 2026-08-15 — Codex: causa funcional documentada; pendiente implementar el
  modelo explícito y la migración de datos.
- 2026-08-15 — Claude: verificado el ejemplo citado ("clip - enemigos tiene.mp4")
  directo en Mongo -- confirmado real (mismo `contentId`, `files` 2/3 resuelto
  vs `remote_library_videos` 3/3). Escaneada la cuenta completa por
  `contentId` compartido: 1117 videos con match entre las dos colecciones, 11
  divergentes, 8 con divergencia de cola real (`queueDivergent`: un lado
  3/3 resuelto y el otro no). Confirmado además en código que
  `applyPlatformPublish` (`backup.controller.ts`) ya trata a `FileModel`
  como fuente primaria (propaga altas de `files` → Nube, nunca al revés) y
  que **ningún camino propaga descartes en ninguna dirección** -- por eso
  las 8 divergencias son una mezcla: unas ganaron un badge en Nube que nunca
  llegó a `files`, otras se descartaron en `files` (Editar links de
  escritorio) sin llegar nunca a Nube.
  **Reconciliados los 10 registros divergentes** (los 8 + 2 menores que
  coincidían en conteo pero no en el detalle) a mano en Mongo, con `files`
  como fuente de verdad en cada uno (criterio confirmado por el usuario:
  Nube es almacenamiento dinámico/temporal, no la fuente primaria) y
  verificación antes/después por registro. Re-escaneo posterior de toda la
  cuenta: **0 divergencias restantes**.
  Esto arregla el SÍNTOMA de datos actual, no la causa -- sin propagación de
  descartes en ninguna dirección, cualquier "Editar links" en escritorio o
  cualquier descarte hecho directo en Nube desde el celular puede volver a
  divergir. La causa de fondo sigue abierta y requiere la propuesta de
  arriba (o como mínimo, propagar también los descartes en
  `applyPlatformPublish`/`updateFilePlatforms`/`RemoteLibraryAPI.updatePlatforms`).

## BUG-2026-08-15-02 — TikTok: badge huérfano + platformUrl nunca se corrige tras resolver el id real

- Estado: `corregido`; pendiente de verificación con una publicación real.
- Reportado: 2026-08-15
- Plataformas: Central (afecta a los 3 clientes que la consultan)
- Severidad: alta (dos videos reales mostraban "Pendiente de datos"/link roto en TikTok)
- Reportado por: usuario

### Síntoma y pasos para reproducir

Dos casos reales encontrados en la cuenta del usuario, ambos con el último
video del Dashboard mostrando TikTok "Pendiente de datos" o con el link roto:

1. "final -raytracing de iphone.mp4" tenía el badge `tiktok` marcado en
   `FileModel.platforms` sin ningún `PlatformVideoModel` vinculado (huérfano)
   -- id, link y métricas inexistentes.
2. "final - rucos con ia.mp4" sí tenía su TikTok real vinculado (con
   `platformId` numérico correcto y métricas reales), pero `platformUrl`
   seguía apuntando al `publish_id` temporal de la operación de subir
   (`.../video/v_pub_file~v2-1...`), no al video real.

### Investigación

Caso 1: el badge no tiene forma de auto-repararse solo -- si el registro real
nunca se creó (o se perdió), no hay stats/refresco en vivo que lo traiga de
vuelta; requiere intervención manual con el link real del video.

Caso 2 es un bug de código real y reproducible para CUALQUIER TikTok futuro
que tarde en resolver: `tiktok-upload.controller.ts` arma `platformId` y
`platformUrl` con el `publish_id` crudo cuando TikTok no devuelve el id real
(`publicaly_available_post_id`) dentro de la ventana de polling de 5 minutos
al publicar. `resolvePendingTikTokIds` (sync.controller.ts) reintenta resolver
el id real en cada refresco de stats y sí lo corrige en `PlatformVideoModel`
y `UploadHistoryModel` -- pero **solo el campo `platformId`, nunca
`platformUrl`**. Tampoco `getFileStats`/`getGroupStats` tocan `platformUrl`
en su refresco en vivo (su `bulkOps.$set` solo escribe
`views/likes/comments/thumbnail`). Resultado: el video queda con stats
funcionando pero el link roto **para siempre**, sin ningún camino de
auto-corrección.

### Corrección

- Datos: los dos registros puntuales de la cuenta del usuario corregidos a
  mano en Mongo (vinculación real vía `applyPlatformPublish` para el caso 1,
  `platformUrl` reconstruida para el caso 2), con verificación antes/después
  de cada mutación.
- Código: `resolvePendingTikTokIds` (`backend/src/controllers/sync.controller.ts`)
  ahora reconstruye y persiste también `platformUrl`
  (`https://www.tiktok.com/@{open_id}/video/{id resuelto}`, mismo patrón que
  usa `tiktok-upload.controller.ts` al publicar) en el mismo momento que
  corrige `platformId`, en `PlatformVideoModel` y `UploadHistoryModel`. Esto
  arregla el caso 2 hacia adelante para cualquier publicación futura que
  tarde en resolver, sin intervención manual.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/`: mismo conteo de errores preexistentes que
  en `main` (27, ninguno nuevo introducido por este cambio) -- el proyecto no
  tiene typecheck limpio en CI, no es una regresión.
- Pendiente: confirmar en producción con una publicación de TikTok real que
  tarde en resolver (`publicaly_available_post_id` fuera de la ventana de 5
  min) que `platformUrl` queda corregida en el siguiente refresco de stats.
- No cubre el caso 1 (badge huérfano) de forma genérica -- si vuelve a
  aparecer un badge sin `PlatformVideoModel` real detrás, sigue requiriendo
  diagnóstico e intervención manual como esta vez.

### Historial
- 2026-08-15 — Claude: diagnóstico verificado directo en Mongo, corrección de
  datos puntual + fix de código en `resolvePendingTikTokIds`.

## BUG-2026-08-15-01 — Dashboard iOS omitía métricas de TikTok en el último video

- Estado: `corregido`; pendiente de verificación en dispositivo iOS.
- Reportado: 2026-08-15
- Plataformas: iOS, Central
- Severidad: alta (la tarjeta principal mostraba un rendimiento incompleto)
- Reportado por: usuario

### Síntoma y pasos para reproducir

Abrir Dashboard en iOS después de publicar el último video en TikTok. La
tarjeta de «Último video publicado» no mostraba las métricas de TikTok.

### Investigación

El Dashboard solo solicitaba `GET /api/sync/file-stats` cuando el último evento
no figuraba en la respuesta resumida de `group-stats`. Si el archivo sí estaba
en esa lista, iOS reutilizaba ese slot aunque fuera cacheado o incompleto para
TikTok, sin disparar el refresco puntual que consulta sus estadísticas.

### Corrección

`DashboardView` ahora pide `file-stats` siempre para el archivo del último
evento y lo prioriza únicamente cuando corresponde a ese mismo evento. La
respuesta puntual refresca las métricas de TikTok y evita que un fallback de un
video anterior se muestre durante una recarga.

### Verificación y pendiente

- Pendiente: compilar y probar en Xcode (no disponible en este entorno).
- Caso mínimo: publicar un TikTok, abrir/refrescar Dashboard y verificar
  vistas, likes y comentarios tanto en la fila TikTok como en el total.

### Historial

- 2026-08-15 — Codex: incidente registrado y flujo de carga corregido.

## BUG-2026-08-13-01 — Calendario TikTok mostraba un último video distinto de Historial

- Estado: `corregido`; pendiente de verificación en un dispositivo iOS con los datos afectados.
- Reportado: 2026-08-13
- Plataformas: iOS, Central
- Severidad: alta (el calendario mostraba una publicación equivocada)
- Reportado por: usuario

### Síntoma y pasos para reproducir

1. Abrir Calendario en iOS y revisar el último publicado para TikTok.
2. Compararlo con el primer elemento de Historial filtrado por TikTok.

El calendario mostraba `reviewers…`, aunque Historial indicaba que esa no fue
la última publicación.

### Resultado esperado / resultado observado

- Esperado: Calendario e Historial identifican la misma última publicación de
  TikTok para el usuario.
- Observado: el calendario podía conservar un título viejo cuando ambas
  publicaciones caían el mismo día. Además, una sincronización tardía podía
  guardar la fecha de recepción del servidor, no la fecha de publicación.

### Investigación

`GET /api/sync/calendar-config` compara el override de `platform_config` con
el video real de `PlatformVideoModel`, pero la comparación usaba solo
`yyyy-MM-dd` y, en empate, elegía el override. `recordUploadEvent` ya escribe
el evento real en Historial y en `PlatformVideoModel`, así que la fuente
dinámica es la correcta para el título mostrado.

### Corrección

- `backend/src/controllers/sync.controller.ts`: en empate de fecha usa la
  publicación dinámica, manteniendo el intervalo configurado manualmente.
- `backend/src/controllers/backup.controller.ts`: al actualizar el calendario
  después de publicar, persiste `publishedAt` del evento y no `new Date()`.

### Verificación y pendiente

- `git diff --check`: correcto.
- `backend`: `npx tsc --noEmit` sigue fallando por errores de tipos ya
  existentes en varios controladores; no aparecieron errores atribuibles a
  esta corrección.
- Pendiente: publicar o sincronizar un TikTok de prueba en iOS y confirmar que
  Calendario e Historial coinciden después de refrescar.

### Historial

- 2026-08-13 — Codex: incidente registrado y corrección aplicada en Central.

## BUG-2026-08-13-02 — Dashboard iOS quedaba en “cancelled” al recargar

- Estado: `corregido`; pendiente de verificación en dispositivo/simulador iOS.
- Reportado: 2026-08-13
- Plataformas: iOS
- Severidad: alta (impedía cargar la métrica del último video)
- Reportado por: usuario

### Síntoma y pasos para reproducir

1. Entrar al Dashboard de iOS.
2. Recargar mientras aún termina la carga inicial, o provocar cargas
   solapadas mediante pull-to-refresh y el refresco tras una publicación.

En ocasiones aparece una tarjeta/error `cancelled` y no carga la métrica del
último video.

### Resultado esperado / resultado observado

- Esperado: una cancelación normal de SwiftUI no se muestra como error; la
  carga más reciente conserva o muestra los datos válidos.
- Observado: una tarea HTTP cancelada llegaba al `catch` de `DashboardView` y
  podía reemplazar el estado visible con su mensaje de cancelación. Una carga
  anterior también podía terminar después de una nueva y sobrescribirla.

### Investigación

`DashboardView.load()` inicia seis solicitudes en paralelo. SwiftUI puede
cancelar una tarea al iniciar otra o al reemplazar la vista; `APIClient` envuelve
esa cancelación como `APIError.network`, que antes se presentaba al usuario.

### Corrección

- `essenalytics-ios/Esse-Analytics/Features/Dashboard/DashboardView.swift`:
  identifica cancelaciones (`CancellationError`/`URLError.cancelled`) y no las
  convierte en banner o tarjeta de error.
- Cada carga tiene un `UUID`; solo la carga activa puede modificar el estado y
  el fallback de métricas del último video.

### Verificación y pendiente

- `git diff --check`: correcto.
- Pendiente: compilar y probar en Xcode, que no está disponible en el entorno
  actual. Caso mínimo: abrir Dashboard y hacer pull-to-refresh repetido; debe
  terminar mostrando la última métrica sin `cancelled`.

### Historial

- 2026-08-13 — Codex: incidente registrado y corrección aplicada en iOS.

## BUG-2026-08-13-03 — Los videos nuevos detectados no aparecían en Videos de Electron

- Estado: `corregido`; pendiente de verificación en Electron.
- Reportado: 2026-08-13
- Plataformas: Web/Electron, local-backend
- Severidad: alta (un archivo nuevo parecía no haberse importado)
- Reportado por: usuario

### Síntoma y pasos para reproducir

1. Guardar un archivo de video compatible en la carpeta configurada para el
   watcher de Electron.
2. Abrir o actualizar la vista **Videos**.

El archivo no aparece en la lista, aunque el watcher lo detecta y crea su fila
local.

### Resultado esperado / resultado observado

- Esperado: la vista inicial muestra los videos nuevos pendientes de publicar.
- Observado: la vista pedía `content_status=parcial` por defecto. Los archivos
  recién detectados se crean como `borrador` y `sin_publicar`, por lo que el
  filtro los excluía antes de renderizarlos.

### Corrección

`frontend/src/components/VideosView.tsx` ahora pide `no_completo` por defecto:
incluye los videos nuevos sin publicar y los publicados parcialmente, pero sigue
ocultando los que ya están completos en las tres plataformas.

### Verificación y pendiente

- Pendiente: refrescar Videos en Electron después de guardar un `.mp4`, `.mov`,
  `.m4v` o `.webm` en la carpeta vigilada; debe aparecer sin activar filtros.

### Historial

- 2026-08-13 — Codex: causa identificada como filtro inicial y corrección aplicada.
