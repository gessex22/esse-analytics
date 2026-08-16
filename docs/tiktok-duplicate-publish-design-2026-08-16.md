# Diseño: publicación duplicada real en TikTok al reintentar desde iOS — 2026-08-16

> Documento de **diseño**, no de implementación. Ningún cambio de código
> acompaña a este documento — ver instrucción de la tarea. Formato y
> profundidad calcados de `docs/mongo-audit-2026-08-13.md` y
> `docs/single-primary-install-plan-2026-08-14.md`.

## Resumen ejecutivo

Al publicar a TikTok desde iOS, un video puede terminar publicado **dos
veces de verdad** en TikTok (dos posts reales, dos `platformId` distintos)
en vez de que Historial simplemente muestre un duplicado cosmético del
mismo post. Causa raíz: TikTok "compromete" la publicación en cuanto
terminan de subirse los chunks — todo lo que pasa después (hasta 5 minutos
de polling esperando el id público final) es solo **observación**, no una
segunda confirmación necesaria. Si la app pasa a background durante esa
espera (algo esperable en un video que tarda minutos en procesarse), iOS
marca la plataforma como `interrumpida`, y el botón "Reintentar" vuelve a
correr **todo el flujo desde cero** — nuevo `publish_id`, resube el archivo
entero — sin saber que la primera subida probablemente ya se publicó o se
va a publicar sola.

Los tres focos de este diseño:

1. Confirmar la causa exacta con citas de código (iOS + central), y por qué
   YouTube/Instagram están mucho menos expuestos al mismo patrón.
2. Evitar la doble publicación real: persistir el punto de no-retorno
   (`publish_id` una vez subidos los bytes) y cambiar "reintentar" por
   "resumir" (consultar el `publish_id` existente en vez de resubir).
3. Reconciliar el id final de forma desacoplada del dispositivo/sesión que
   publicó — evaluando un job periódico en la central (que ya tiene el
   token) contra el mecanismo "cualquier cliente que lo vea" que **ya existe
   parcialmente** en el código de hoy.
4. El problema de re-keying en Mongo: cómo migrar un registro de
   `publish_id` provisorio a su `platformId` final sin duplicar documentos,
   con un patrón de índice que **ya existe en este repo** para un caso
   análogo.

Android **ya tiene un comentario explícito en su código reconociendo este
mismo riesgo** (`TiktokUploader.kt:54-60`) y una mitigación parcial
(`retryable = false` tras subir los bytes, para no dejar que WorkManager
reintente solo) — pero tampoco resuelve el problema de fondo (un reintento
manual del usuario sigue resubiendo desde cero). Se detalla en la sección 5.

---

## 1. Confirmación de la causa raíz

### 1.1 — iOS: `TikTokUploader.swift`

`essenalytics-ios\Esse-Analytics\Features\Upload\TikTokUploader.swift`:

- `upload()` (líneas 31-54) es una función monolítica: `initiate()` →
  `uploadChunks()` → `waitForCompletion()`, todo en una sola llamada async
  sin puntos de persistencia intermedios. Ningún estado sobrevive fuera de
  las variables locales de esta función.
- `initiate()` (líneas 78-121) pide un `publish_id` **nuevo** a TikTok cada
  vez que se llama — no hay forma de pedirle a TikTok "seguí con el que ya
  tenías", ni un idempotency key en la request (`body` en líneas 90-107 no
  incluye ningún identificador cliente-generado que TikTok pueda usar para
  deduplicar).
- `uploadChunks()` (líneas 123-161) sube el archivo completo por `PUT`. Una
  vez que retorna sin lanzar, **TikTok ya tiene el archivo completo y ya
  fue instruido a publicarlo** (con el `privacy_level`/`title`/etc. que se
  mandó en `initiate()`). Este es el punto de no-retorno real.
- `waitForCompletion()` (líneas 168-204) es **puro polling de status**: no
  manda ningún dato nuevo, no "confirma" nada — TikTok sigue procesando y
  publicando el video exista o no este polling. El comentario en líneas
  163-167 ya lo documenta: `publishId` "es solo el id de la operación de
  publicar", y la función solo está tratando de averiguar el id público
  real (`publicaly_available_post_id`, típo de TikTok) antes de que se le
  acabe la paciencia (`attempts < 60`, 5s cada uno = 5 min, línea 175).
  Si nunca lo consigue, cae al propio `publishId` como id (línea 48) — ya
  sabiendo que el link va a estar roto, pero **el video igual va a estar
  publicado**.
- No hay `URLSession` en background ni `beginBackgroundTask` en ningún
  punto de este archivo — confirmado (no hay ninguna referencia a
  `URLSessionConfiguration.background` ni `UIApplication.beginBackgroundTask`
  en `Features/Upload/`). El polling de 5 minutos corre en una `Task`
  normal, que **se cancela** si la app pasa a background más allá de la
  ventana de gracia de iOS.

### 1.2 — iOS: `PublishFormView.swift`

`essenalytics-ios\Esse-Analytics\Features\Upload\PublishFormView.swift`:

- `PendingPublishBatch` (líneas 53-58) y `PlatformPublishState` (líneas
  38-47) son el único estado que sobrevive un kill/background — se
  serializan en `UserDefaults` (`persistPendingBatch`, líneas 680-690).
  Pero `PlatformPublishState` **no tiene ningún campo para el `publish_id`
  provisorio** — solo `stage`, `progress`, `lastMessage`, `finalURL`,
  `error`, `startedAt`, `finishedAt`. No hay dónde guardar "ya subí los
  bytes, esto quedó en `publish_id=X`, no resubas".
- `onChange(of: scenePhase)` (líneas 453-457) llama
  `markCurrentBatchInterrupted()` en cuanto la app pasa a background
  mientras `isPublishing` es true — **sin distinguir** si la interrupción
  pasó durante la subida de bytes (donde reintentar desde cero es correcto,
  nada se publicó todavía) o durante el polling posterior a
  `uploadChunks()` (donde reintentar desde cero puede publicar dos veces).
  `markCurrentBatchInterrupted()` (líneas 700-712) marca como
  `.interrupted` cualquier plataforma en `.pending`, `.uploading` **o
  `.processing`** — y `.processing` es exactamente el estado que
  `publish()` asigna (línea 1064) justo antes de esperar el resultado de
  `performUpload`, que para TikTok incluye todo el polling de 5 minutos.
- `retryInterrupted()` (líneas 660-667) y `retryFailed()` (líneas 613-620)
  hacen lo mismo: juntan las plataformas no confirmadas y llaman
  `publishAll()` de nuevo, que en `publish()` (línea 1054) llama
  `performUpload(platform:fileURL:)` — que para TikTok (líneas 1139-1155)
  instancia un `TikTokUploader()` **nuevo** y llama `.upload()` desde cero.
  No hay ninguna rama que pregunte "¿ya había un `publish_id` en vuelo para
  esto?".
- `UploadCoordinator.recordSuccess` (`UploadCoordinator.swift:12-92`) es el
  único lugar que registra algo en SwiftData/la central, y **solo se llama
  si `publish()` llega al `try await UploadCoordinator.recordSuccess(...)`
  en la línea 1066** — es decir, solo con el resultado final ya resuelto.
  No existe ningún registro intermedio de "esto está en processing con
  `publish_id=X`" en SwiftData, UserDefaults con ese dato, ni la central.

**Conclusión 1.1+1.2**: la causa raíz descrita en la tarea está confirmada
tal cual, letra por letra, contra el código real.

### 1.3 — Central: `applyPlatformPublish`/`recordUploadEvent`

`content-automation-dashboard\backend\src\controllers\backup.controller.ts`:

- `applyPlatformPublish` (líneas 874-1061) hace upsert por
  `{ userId, platform, platformId }` (línea 1009-1023) — coincide con lo
  descrito en la tarea. Es idempotente **solo si el `platformId` es el
  mismo** en ambas llamadas.
- Como cada reintento de iOS genera un `publish_id` nuevo (o, si el
  segundo intento sí resuelve el id real, un `platformId` numérico
  distinto al del primer intento, que TikTok también resolvió por su
  cuenta más tarde), los dos posts terminan como **dos documentos
  distintos** en `PlatformVideoModel`/`UploadHistoryModel` — no hay
  colisión de índice que los frene, porque de verdad son dos identidades
  distintas del lado de TikTok. La idempotencia de Mongo no puede arreglar
  esto porque **no es un bug de Mongo — son dos publicaciones reales**.
- `recordUploadEvent` (líneas 1076-1142) delega en `applyPlatformPublish` y
  hace su propio upsert sobre `UploadHistoryModel` con el mismo criterio
  (línea 1107-1126) — mismo problema, mismo motivo.

### 1.4 — Dónde vive el token de TikTok (confirma la idea 1 del usuario)

`content-automation-dashboard\local-backend\src\controllers\tiktok-upload.controller.ts`,
`fetchToken()` (líneas 17-26): el local-backend (desktop) **no tiene** el
token de TikTok — lo pide a la central en cada subida
(`GET /api/tiktok/token` vía `CENTRAL/api/tiktok/token`, usando el
`Authorization` header del usuario). Confirmado también del lado iOS:
`TikTokUploader.swift:65-71`, `fetchToken()` llama
`apiClient.get("api/tiktok/token")` — que en el modo normal (no "PC local")
apunta a la central.

El token real (`access_token`/`refresh_token`) vive en la central, y el
refresco automático ya está resuelto ahí: `getValidToken(userId)`
(`backend\src\controllers\tiktok-upload.controller.ts:51-65`) refresca solo
si hace falta (`needsRefresh`, línea 59) usando el `refresh_token`
guardado. Es una función que toma `userId` como único parámetro — **no
depende de nada del request HTTP en curso** (headers, sesión, etc.), lo que
confirma que se puede llamar perfectamente desde un job de servidor sin
ningún cliente conectado. De hecho, ya se usa así:
`backend\src\services\tiktok.service.ts:24-50`
(`resolveTikTokVideoId`, importa `getValidToken` desde el controller,
línea 4) hace exactamente esto — consulta el status de un `publish_id` por
su cuenta, con solo el `userId`, sin ningún dato que dependa del
dispositivo que publicó. **La central YA puede, hoy, resolver el estado de
un `publish_id` de TikTok sin ayuda del teléfono** — la pieza que falta no
es "conseguir el token", es "saber que hay algo pendiente y cuándo
mirarlo" (ver sección 3).

### 1.5 — ¿Es específico de TikTok, o YouTube/Instagram tienen el mismo riesgo?

Comparación punto por punto, con los 3 uploaders de iOS:

| | Cuándo TikTok/YouTube/Meta "compromete" la publicación | Ventana de riesgo tras comprometerse | ¿Hay wait/polling externo largo después? |
|---|---|---|---|
| **TikTok** (`TikTokUploader.swift`) | En cuanto `uploadChunks()` retorna OK (línea 41) — el `post_info` con título/privacidad ya se mandó en `initiate()` (línea 40), los bytes ya llegaron. | Los ~5 minutos completos de `waitForCompletion()` (línea 43), con la app típicamente en uso pasivo esperando. | **Sí** — hasta 60 polls × 5s, sin ninguna acción del cliente requerida para que el video salga público. |
| **YouTube** (`YouTubeUploader.swift`) | Recién cuando el **último** `PUT` de `uploadChunks()` responde 200 con el JSON final (`ChunkResponse`, líneas 123-168) — YouTube no expone una API pública para crear el video de forma resumible-por-partes que uno pueda "comprometer" antes del byte final; el recurso `video` no existe hasta esa respuesta. | Solo la cola/vuelta de ESE último `PUT` (una llamada HTTP, no un proceso de minutos). Si se interrumpe ANTES de esa respuesta, YouTube probablemente ni terminó de procesar el video como recurso completo. | **No** — `upload()` retorna directo con el resultado final, línea 40-44; `publish()` en `PublishFormView` pasa a `.processing` (línea 1064) solo por el instante entre ese retorno y `recordSuccess`, no hay espera activa. |
| **Instagram** (`InstagramUploader.swift`) | Recién en `publish()` (líneas 162-176), que llama `media_publish` — **una llamada aparte** de la creación/procesamiento del container (`createAndWaitContainer`, líneas 110-160). Mientras el container está `IN_PROGRESS`/`FINISHED` (sin publicar), nada es público todavía. | Reducida al tiempo de ESA llamada `media_publish` (rápida, no hay polling después). El polling largo (`attempts < 72`, 6 min, líneas 144-155) pasa **antes** de comprometerse — si se interrumpe ahí, no hay nada público que duplicar, un reintento completo (nuevo container) es seguro. | Sí hay un wait largo, pero está **antes** del punto de no-retorno, no después — al revés que TikTok. |

**Conclusión**: el patrón de riesgo es específico de TikTok por una razón
estructural de su API, no por un descuido puntual del código: TikTok separa
"publicar" (implícito en `init` + chunks) de "informar el resultado"
(polling de status), y ese polling es largo y ocurre **después** del punto
de no-retorno. YouTube no tiene una espera larga en ese punto (todo pasa en
la respuesta del último chunk). Instagram sí tiene una espera larga, pero
ocurre **antes** de la llamada que de verdad publica (`media_publish`), así
que un reintento completo ahí es seguro — el riesgo real de Instagram queda
acotado a la ventana (corta) de la llamada `media_publish` en sí, análoga
a la de YouTube. Ninguno de los dos está en riesgo cero en teoría (ver
sección 6 — se anota como mejora de fase posterior), pero el de TikTok es
órdenes de magnitud más probable de gatillarse en la práctica porque
coincide con el momento en que es MÁS esperable que el usuario suelte la
app (procesando en background, tarda minutos).

`content-automation-dashboard\local-backend\src\controllers\tiktok-upload.controller.ts`
(líneas 96-184) replica el mismo patrón en desktop: `initiate` → chunks →
polling de 5 min (líneas 148-174), sin persistir el `publish_id` en SQLite
hasta el final (`platformVideoRepo.upsert`, línea 188, es lo último que
pasa). Ahí el riesgo es mucho menor en la práctica — no hay "background" en
un proceso Express de escritorio, solo un cierre completo de la PC/proceso
mataría el polling — pero **el mismo patrón estructural existe** y no está
cubierto por este diseño (queda anotado como candidato a fase posterior en
la sección 6).

---

## 2. Diseño: evitar la doble publicación real (iOS)

### 2.1 — Punto de no-retorno: persistir el `publish_id` apenas terminan los chunks

Extender `PlatformPublishState` (`PublishFormView.swift:38-47`) con dos
campos nuevos:

```swift
struct PlatformPublishState: Codable, Equatable {
    let platform: Platform
    var stage: PlatformPublishStage = .pending
    var progress: Double?
    var lastMessage: String?
    var finalURL: String?
    var error: String?
    var startedAt: Date?
    var finishedAt: Date?
    // NUEVO:
    var providerOperationId: String?   // publish_id de TikTok (u operationId equivalente futuro de otra plataforma)
    var bytesCommitted: Bool = false   // true apenas uploadChunks() retorna OK — de acá en más, NUNCA resubir
}
```

Esto ya usa el mecanismo de persistencia que existe
(`persistPendingBatch()`, líneas 680-690, escribe todo `platformStates` a
`UserDefaults` bajo `pendingPublishBatchDefaultsKey`) — no hace falta
SwiftData ni un mecanismo nuevo de storage, alcanza con que el `publish_id`
viaje dentro de la misma estructura que ya sobrevive un kill de la app.

Para que `PublishFormView` se entere del `publish_id` a mitad de
`TikTokUploader.upload()` (hoy es una caja negra que solo devuelve el
resultado final), hace falta un canal de esa información. Dos opciones:

- **(A) Callback nuevo**, mismo patrón que `onProgress`:
  `onOperationCommitted: (String) -> Void`, invocado en `TikTokUploader`
  justo después de que `uploadChunks()` retorna OK (entre las líneas 41 y
  42 de `TikTokUploader.swift`), con el `publishId`. `performUpload` (en
  `PublishFormView.swift`, línea 1093) lo conecta a
  `platformStates[platform]?.providerOperationId = publishId; bytesCommitted = true; persistPendingBatch()` —
  persistencia **síncrona e inmediata**, no esperar a que termine
  `publish()`.
- **(B) Descomponer `TikTokUploader.upload()`** en pasos explícitos
  (`initiate()`, `uploadChunks()`, `waitForCompletion()` ya casi lo están,
  son funciones privadas separadas) y que `PublishFormView` orqueste desde
  afuera, llamando a cada paso y persistiendo entre medio.

Se recomienda **(A)**: cambia menos la forma del uploader (sigue
implementando `PlatformUploader` con la misma firma pública), y mantiene el
polling encapsulado adentro de `TikTokUploader` en vez de exponer sus
detalles a la vista.

### 2.2 — Retry ⇒ Resume, no resubir

`TikTokUploader` necesita un segundo punto de entrada, además de
`upload()`:

```swift
func resume(
    publishId: String,
    onProgress: @escaping (Double, String?) -> Void
) async throws -> UploadResult
```

Que sea literalmente `waitForCompletion(publishId:accessToken:onProgress:)`
(ya existe, líneas 168-204) con un `fetchToken()` propio adelante — sin
`initiate()` ni `uploadChunks()`. Si `waitForCompletion` termina en
`FAILED`, sigue lanzando `UploadError.rejected(...)` tal cual ya hace hoy
(línea 196) — eso ya es la señal correcta de "esto no se publicó, un
reintento nuevo es seguro" (ver 2.3).

`performUpload(platform:fileURL:)` (`PublishFormView.swift:1093`) pasa a
decidir, ANTES de instanciar un uploader nuevo:

```swift
if platform == .tiktok,
   let state = platformStates[.tiktok],
   state.bytesCommitted,
   let opId = state.providerOperationId {
    return try await TikTokUploader().resume(publishId: opId, onProgress: onProgress)
}
// (rama existente: upload() completo)
```

Este chequeo cubre tanto `retryFailed()` como `retryInterrupted()` sin
tocarlos — ambos ya convergen en `publishAll()` → `publish()` →
`performUpload()`, que es el único lugar que necesita el `if`.

### 2.3 — Si TikTok ya devolvió `FAILED` para ese `publish_id`

`resume()` debe distinguir dos casos de error:

- **`FAILED` confirmado por TikTok** (el `status` del polling es
  literalmente `"FAILED"`, con `fail_reason`) → el intento anterior de
  verdad no se publicó. Acá SÍ hay que permitir un intento nuevo completo:
  limpiar `bytesCommitted`/`providerOperationId` de ese `PlatformPublishState`
  y dejar que la siguiente llamada a `performUpload` caiga en la rama
  normal de `upload()` completo (re-subir el archivo, porque TikTok
  probablemente ya descartó los chunks del intento fallido).
- **Cualquier otro error** (timeout de nuevo, red caída, `publish_id`
  desconocido/expirado del lado de TikTok) → **no** se puede asumir que no
  se publicó. Queda igual que antes: `interrupted`/`failed` pero
  conservando `providerOperationId`, para que el próximo reintento vuelva a
  intentar `resume()` en vez de resubir. El usuario puede reintentar tantas
  veces como quiera sin volver a arriesgar un duplicado real, porque
  `resume()` nunca vuelve a llamar `initiate()`/`uploadChunks()`.

Esto requiere que `resume()` propague explícitamente si el error fue
"FAILED confirmado" vs "no se pudo confirmar nada" — por ejemplo agregando
un caso a `UploadError` (`UploadError.tiktokConfirmedFailed(reason:)`) que
`waitForCompletion` ya puede lanzar en vez del genérico
`UploadError.rejected` que usa hoy en la línea 196, sin cambiar su
comportamiento para el caller de `upload()` normal (ambos siguen siendo
errores que `publish()` atrapa igual, línea 1080-1082) — el único caller
nuevo que necesita distinguir el caso es la lógica de limpieza de 2.2/2.3
en `performUpload`.

### 2.4 — ¿Cuánto tiempo es válido `publish_id` para `resume()`?

Punto abierto que requiere verificación contra la documentación de la
Content Posting API de TikTok (o prueba real) antes de implementar: no hay
evidencia en este código de una ventana de expiración documentada para
`publish_id` más allá de que las respuestas de `status/fetch` dejan de
tener sentido una vez el video ya es público (`PUBLISH_COMPLETE`/
`SEND_TO_USER_INBOX` son estados terminales, línea 170). Si TikTok expira
el `publish_id` pasado un tiempo (por ejemplo, 24-48h), un usuario que deja
el "Reintentar pendientes" sin tocar por varios días necesita, en algún
momento, la opción de "esto ya no se puede resumir, ¿querés intentar de
nuevo desde cero?" — a diferenciar de un simple botón "Reintentar" para no
inducir al usuario a resubir algo que ya está público. Se deja como
decisión de UX a tomar en la fase de implementación (ver sección 6), con
un candidato razonable: si `resume()` devuelve un error de TikTok tipo
"invalid publish_id"/404, tratarlo igual que 2.3 (permitir intento nuevo).

---

## 3. Diseño: reconciliación del id final, desacoplada del dispositivo

### 3.1 — Lo que ya existe hoy (no es un diseño desde cero)

`backend\src\controllers\sync.controller.ts`, función
`resolvePendingTikTokIds` (líneas 452-500), ya implementa la mitad del
patrón "cualquier cliente que lo vea lo reconcilia":

- Se llama desde `getGroupStats` (línea 604) y `getFileStats` (línea 792)
  — cada vez que un cliente (cualquiera: Electron, iOS, Android, web
  remoto) pide stats de un archivo/grupo, si encuentra un `platformId` de
  TikTok que no es puramente numérico (`!/^\d+$/.test(...)`, línea 463),
  llama `resolveTikTokVideoId(userId, ...)` (`tiktok.service.ts:24-50`) —
  que sí usa el token de la central, no del dispositivo — y si resuelve,
  actualiza `PlatformVideoModel` (línea 484-487) y `UploadHistoryModel`
  (línea 494-497) **en el lugar**, vía `updateOne` filtrando por el
  `platformId` viejo.
- Esto ya resuelve el caso simple de la tarea (idea 1: "que no dependa del
  dispositivo ni de cuánto tiempo tenga la app abierta") — para el
  problema de **resolver un id**, no para el de **duplicados reales**.

**Gap real encontrado**: `getUploadHistory`
(`backup.controller.ts:1149-1189` — el endpoint que sirve exactamente la
vista de Historial donde el usuario ve el duplicado) **no llama a
`resolvePendingTikTokIds`**. Es el único de los tres consumidores
(`getGroupStats`, `getFileStats`, `getUploadHistory`) que no lo hace. Si el
usuario solo mira Historial y nunca Estadísticas/Dashboard para ese video,
el `publish_id` crudo nunca se reconcilia — puramente por esta omisión, no
por un límite de diseño.

### 3.2 — Client-triggered (extender lo que ya existe) vs. job central

| | **Client-triggered** (patrón actual, extendido) | **Job periódico en la central** (patrón nuevo) |
|---|---|---|
| Esfuerzo | Bajo — agregar la misma llamada a `getUploadHistory` cierra el gap de 3.1 inmediatamente. | Medio — nueva función + registrar el `setTimeout` en `server.ts`, pero el patrón ya existe (ver 3.3). |
| Cubre Historial sin que nadie mire nada | **No** — si ningún cliente pide stats/historial de ESE archivo, queda sin resolver indefinidamente. | **Sí** — corre solo, sin depender de que alguien abra la app. |
| Carga en la API de TikTok | Proporcional a vistas reales (bajo). Si 3 dispositivos miran el mismo video pendiente casi al mismo tiempo, puede llamar `resolveTikTokVideoId` 3 veces para lo mismo (no hay lock) — desperdicio menor, no rompe nada (`resolveTikTokVideoId` es idempotente). | Constante, un scan periódico — pero con salida temprana si no hay nada pendiente (`countDocuments` barato antes de llamar a la API), así que en la práctica es ~0 la mayor parte del tiempo. |
| Resuelve el problema de "dos publicaciones reales" | No — solo resuelve la FORMA del id (`publish_id` → numérico), no decide qué hacer si hay dos `PlatformVideoModel` reales para el mismo archivo. | Tampoco por sí solo, pero es el lugar natural para, además, marcar/alertar cuando detecta 2 documentos `pendingConfirmation` para el mismo `linkedFileId`+plataforma (ver 4.4). |
| Consistencia con el resto del backend | Ídem patrón ya usado (best-effort, silencioso). | Ídem patrón ya usado en `scheduleRemoteLibraryRetentionSweep` (`server.ts:82-102`) — no es una introducción de infraestructura nueva. |

**Recomendación: los dos, no uno solo.**

1. **Quick win, independiente del resto**: agregar la llamada a
   `resolvePendingTikTokIds` también en `getUploadHistory`
   (`backup.controller.ts:1149`) — cierra el gap de 3.1 con el mínimo
   cambio posible, reusando código que ya existe y ya está probado
   (ver `BUG-2026-08-15-02` en `bug-reports.md`, que ya lo endureció una
   vez).
2. **Job periódico** como mecanismo de fondo que no depende de que un
   cliente mire nada — ver 3.3. Reemplaza la responsabilidad de "closear"
   pendientes de TikTok de los clientes hacia la central, que es
   justamente lo que pide la idea 1 del usuario ("se resuelva en background
   ... sin depender del teléfono").
3. El client-triggered actual queda como **camino rápido** (repara en el
   momento si alguien mira antes de que corra el próximo ciclo del job),
   no se elimina.

### 3.3 — Dónde viviría el job

`server.ts:82-102` ya tiene el patrón exacto a reusar —
`scheduleRemoteLibraryRetentionSweep`, un `setTimeout` autorecursivo
registrado en el callback de `mongoose.connect(...).then(...)`, con
logging de resultado y manejo de error que no tumba el proceso:

```ts
const TIKTOK_RECONCILIATION_INTERVAL_MS = 2 * 60 * 1000; // 2 min — más seguido
                                                            // que retention (1h) porque
                                                            // acá el usuario está mirando
                                                            // Historial recién publicado

function scheduleTikTokReconciliation(): void {
  runTikTokPendingReconciliation()
    .then(r => console.log(`[tiktok-reconciliation] pendientes=${r.pending} resueltos=${r.resolved} siguenPendientes=${r.stillPending}`))
    .catch(err => console.error('[tiktok-reconciliation] error:', err.message));
  setTimeout(scheduleTikTokReconciliation, TIKTOK_RECONCILIATION_INTERVAL_MS);
}
```

Registrado al lado de `scheduleRemoteLibraryRetentionSweep()` (línea 102),
en un archivo nuevo `backend/src/services/tiktok-reconciliation.service.ts`
(mismo patrón de ubicación que
`services/remote-library-retention.service.ts`, que es lo que
`runRemoteLibraryRetentionSweep` importa hoy).

Sería **el primer job periódico dedicado a un dominio de publicación** en
este repo (el existente es de retención de storage, dominio distinto) —
pero no el primer job periódico en general, así que no introduce un patrón
nuevo de infraestructura, solo un nuevo caso de uso del mismo.

Lógica interna (alto nivel, sin código de implementación):

1. Query barata: `PlatformVideoModel.find({ platform: 'tiktok', pendingConfirmation: true })`
   (ver campo nuevo en sección 4) — si no hay nada, listo, no llama a
   TikTok para nada.
2. Agrupar por `userId` (varios pendientes del mismo usuario comparten
   token/refresh).
3. Por cada pendiente: `resolveTikTokVideoId` (ya existe) + reconstrucción
   de `platformUrl` (mismo patrón que `resolvePendingTikTokIds` ya hace).
4. Reconciliar también `UploadHistoryModel` (mismo `_id` lógico, ver
   sección 4) — esto es lo que hoy `resolvePendingTikTokIds` hace bien
   para `PlatformVideoModel` pero que necesita este job para que
   **también** llegue a Historial sin que nadie lo mire.
5. Backoff simple por antigüedad: no tiene sentido pollear cada 2 minutos
   algo pendiente desde hace 3 días (probablemente esté en un estado raro
   — token revocado, cuenta desconectada, etc.) — el mismo criterio de
   `statsCacheWindowMs` (`sync.controller.ts:445-450`) es reusable acá.

---

## 4. El problema de re-keying en Mongo

### 4.1 — Por qué el patrón actual es fatalmente ambiguo con dos publicaciones reales

`resolvePendingTikTokIds` decide "esto es un `publish_id` sin resolver" con
una heurística de **forma del valor**: `!/^\d+$/.test(platformId)`
(línea 463). Esto funciona para el caso de un solo pendiente, pero:

- No distingue "está pendiente de resolver" de "es legítimamente
  no-numérico" (un shortcode de Instagram pegado a mano, por ejemplo, si
  algún día se reusara la misma función para otra plataforma).
- Si el formato del `publish_id` de TikTok cambiara (empezara con dígitos,
  por ejemplo), la heurística se rompe en silencio.
- Cuando hay **dos publicaciones reales** para el mismo archivo+plataforma
  (el bug de esta tarea), puede haber dos documentos con `platformId`
  no-numérico simultáneamente, y la función los procesa a ciegas uno por
  uno sin ningún concepto de "esto son intentos relacionados del mismo
  archivo" — no hay forma de que decida cuál es el bueno, ni de fusionarlos.

### 4.2 — Propuesta: campo dedicado, no heurística de forma

Agregar a `PlatformVideoModel` (`backend\src\models\platform-video.model.ts`)
y `UploadHistoryModel` (`backend\src\models\upload-history.model.ts`) dos
campos nuevos, **sin tocar los campos existentes**:

```ts
provisionalId?: string;        // publish_id crudo de TikTok mientras no hay id final
pendingConfirmation?: boolean; // true mientras platformId === provisionalId (todavía no resuelto)
```

`platformId` **sigue poblándose igual que hoy** (con el `publish_id` crudo
mientras no se resuelve — así ningún consumidor existente que lee
`platformId` se rompe), pero el job/reconciliación de la sección 3 ya no
necesita adivinar por forma: filtra directo por `pendingConfirmation: true`.

Esto es exactamente lo que pidió la tarea ("guardar el publishId
provisorio en un campo aparte... y buscar por ese campo al reconciliar, en
vez de intentar mutar la clave primaria de negocio") — con la diferencia de
que no hace falta dejar `platformId` vacío/null (evita relajar el
`required: true` que ya tiene el schema, línea 37 de
`platform-video.model.ts` y línea 36 de `upload-history.model.ts`), solo
sumar metadata al lado.

### 4.3 — Reconciliar por `_id`, no por valor de `platformId`

Hoy `resolvePendingTikTokIds` reconcilia con:

```ts
await PlatformVideoModel.updateOne(
  { userId, platform: 'tiktok', platformId: oldId },
  { $set: { platformId: resolved, ... } },
);
```

(línea 484-487) — filtra por el **valor viejo** de la clave de negocio. Es
razonable para el caso de un pendiente aislado, pero es fràgil si dos
documentos llegaran a tener el mismo `platformId` viejo por cualquier
motivo transitorio (no debería pasar dado el índice único, pero decidir
"cuál" no es explícito). La reconciliación del job nuevo (sección 3)
debería guardar y usar el `_id` de Mongo capturado en el momento en que el
documento pendiente se creó (ver 4.4), y hacer:

```ts
await PlatformVideoModel.updateOne(
  { _id: doc._id },
  { $set: { platformId: resolved, pendingConfirmation: false }, $unset: { provisionalId: '' } },
);
```

Mutar por `_id` es estrictamente más seguro que mutar por el valor de un
campo que forma parte del índice único que se está a punto de cambiar —
nunca hay ambigüedad de "cuál era el documento que yo estaba mirando".

### 4.4 — Cuándo se crea el documento `pendingConfirmation`

Para que la central sepa que algo quedó pendiente **sin depender de que el
dispositivo siga vivo** (la idea 1 del usuario), el punto de no-retorno de
iOS (sección 2.1: justo después de `uploadChunks()`) debe reportarse a la
central en cuanto pasa — no recién al final como hoy
(`UploadCoordinator.recordSuccess`, solo tras éxito total).

Nuevo endpoint, mismo estilo que los existentes en
`backend\src\routes\sync.routes.ts`:

```
POST /api/sync/history/pending
```

Body: `{ platform: 'tiktok', provisionalId: string, fileName?, contentId?, title? }`
(sin `platformId` final, porque todavía no existe). El controller (nuevo,
al lado de `recordUploadEvent` en `backup.controller.ts`) hace un
`PlatformVideoModel.updateOne({ userId, platform, provisionalId },
{ $setOnInsert: {...}, $set: {...} }, { upsert: true })` — upsert por
`provisionalId`, no por `platformId`, evitando el problema de que
`platformId` todavía no tiene un valor final estable.

`UploadCoordinator` en iOS llamaría a este endpoint desde el nuevo callback
`onOperationCommitted` de la sección 2.1 (best-effort, sin bloquear la
subida real — mismo criterio que ya usa para `recordSuccess`, líneas 48 y
81 de `UploadCoordinator.swift`, "si falla la subida real ya se registró
igual").

Con este documento ya en Mongo apenas se comprometen los bytes:

- El job de la sección 3 lo encuentra sin depender de que el teléfono siga
  publicando o conectado.
- Si el usuario reintenta desde OTRO dispositivo (o reinstala la app, o
  cambia de teléfono) antes de que se resuelva, la central ya sabe que hay
  un `publish_id` en vuelo para ese archivo+plataforma — pieza que abre la
  puerta (no incluida en el alcance de este documento, ver sección 6) a
  que el propio backend le devuelva al cliente "ya hay una subida en curso
  para esto, no la repitas" en vez de que el cliente decida solo con su
  propio estado local (`PendingPublishBatch` en `UserDefaults`, que no
  sobrevive un cambio de dispositivo).

### 4.5 — Índice: el patrón de índice parcial ya existe en este repo

`RemoteLibraryVideoModel` (`backend\src\models\remote-library-video.model.ts:76-79`)
ya usa exactamente el patrón necesario para agregar un índice único sobre
`provisionalId` sin romper documentos que no lo tienen:

```ts
remoteLibraryVideoSchema.index(
  { userId: 1, contentId: 1 },
  { unique: true, partialFilterExpression: { contentId: { $type: 'string' } } },
);
```

Aplicado al caso nuevo:

```ts
platformVideoSchema.index(
  { userId: 1, platform: 1, provisionalId: 1 },
  { unique: true, partialFilterExpression: { provisionalId: { $type: 'string' } } },
);
```

Esto permite el upsert de 4.4 sin colisionar con documentos viejos (que no
tienen `provisionalId`), y sin tocar el índice único existente
(`{ userId, platform, platformId }`, línea 57) — **no hace falta ninguna
migración de datos**, solo `createIndex` (Mongoose lo crea solo al levantar
si el modelo declara el índice nuevo; documentos existentes sin
`provisionalId` quedan afuera del filtro parcial automáticamente).

### 4.6 — Endpoints/controllers a tocar

| Archivo | Cambio |
|---|---|
| `backend/src/models/platform-video.model.ts` | Agregar `provisionalId?`, `pendingConfirmation?` al schema + índice parcial (4.5). |
| `backend/src/models/upload-history.model.ts` | Mismos dos campos (para que el job de 3.3 también corrija Historial). |
| `backend/src/controllers/backup.controller.ts` | Nueva función `recordPendingPublish` (upsert por `provisionalId`, 4.4). `getUploadHistory` (línea 1149) gana la llamada a `resolvePendingTikTokIds` (3.1). |
| `backend/src/controllers/sync.controller.ts` | `resolvePendingTikTokIds` pasa a filtrar por `pendingConfirmation: true` en vez de la regex de forma (4.2), y a reconciliar por `_id` (4.3). |
| `backend/src/routes/sync.routes.ts` | Nueva ruta `POST /api/sync/history/pending`. |
| `backend/src/services/tiktok-reconciliation.service.ts` (nuevo) | El job de 3.3. |
| `backend/src/server.ts` | Registrar `scheduleTikTokReconciliation()` al lado de `scheduleRemoteLibraryRetentionSweep()` (línea 102). |

---

## 5. Paridad Android

`essenalytics-android\feature\upload\src\main\kotlin\com\esseanalytics\android\feature\upload\TiktokUploader.kt`:
mismo flujo que iOS (`initUpload` → `uploadChunks` → `pollUntilComplete`,
líneas 38-93), **con un comentario explícito ya en el código actual**
reconociendo este exacto riesgo (líneas 54-60):

> "NO retryable: acá los bytes YA se terminaron de subir y TikTok puede
> seguir procesando/publicando en segundo plano después de que este poll
> se rindió -- reintentar desde cero (init nuevo + resubir todo) puede
> terminar publicando el mismo video DOS veces si el original termina de
> procesar segundos más tarde. Mejor dejar que el usuario reintente a
> mano y así vea si realmente hace falta."

Mitigación parcial ya implementada: cuando `pollUntilComplete` devuelve
`null` (se agotaron los intentos sin `PUBLISH_COMPLETE`/`FAILED`), el
`UploadResult.Failure` se marca `retryable = false` (línea 62-65). En
`UploadWorker.kt` (líneas 153-159), `Result.retry()` de WorkManager (que
reintentaría **automáticamente**, con backoff, sin que el usuario haga
nada) solo se dispara si `result.retryable && runAttemptCount < MAX_RETRIES`
— con `retryable = false`, WorkManager nunca reintenta solo este caso, cae
directo a `Result.failure(...)`.

**Lo que Android NO tiene** (mismo hueco estructural que iOS):

- Si el usuario, viendo el fallo, dispara un reintento **manual** (nuevo
  `WorkRequest` para el mismo archivo+plataforma), `UploadWorker.doWork()`
  (línea 94-97) llama `uploader.upload(...)` desde cero otra vez — no hay
  ningún `resume(publishId:)` ni persistencia del `publish_id` entre
  intentos. `TiktokUploader.kt` no persiste `init.publishId` en ningún
  lado fuera de la variable local de `upload()` (línea 44).
- Es decir: Android **ya decidió, con criterio correcto, no dejar que la
  plataforma reintente sola** — pero el reintento manual del usuario tiene
  exactamente el mismo bug que iOS.

**Conclusión de paridad**: sí aplica, con el mismo patrón de causa raíz
(TikTok compromete la publicación antes del polling largo). La sección 2
de este diseño (persistir `publish_id`, exponer `resume()`, distinguir
`FAILED` confirmado) aplica 1:1 a `TiktokUploader.kt`/`UploadWorker.kt` —
no se diseña en detalle acá (fuera de alcance de esta tarea), pero el
comentario ya existente en el código Android es la mejor evidencia de que
el equipo (o una sesión anterior) ya había identificado el riesgo antes de
esta investigación, sin haberlo resuelto del todo.

---

## 6. Plan de implementación por fases

Orden por riesgo/esfuerzo — cada fase es útil por sí sola, ninguna depende
de que las siguientes se implementen.

### Fase 0 — Quick win sin riesgo (central, ~1 endpoint)

- Agregar `resolvePendingTikTokIds` a `getUploadHistory`
  (`backup.controller.ts:1149`, ver 3.1).
- **Verificable sin build de iOS**: es un cambio 100% central
  (`backend/`), se prueba con `npm run dev` en `backend/` + un `curl`/
  Postman a `/api/sync/history` con un usuario que tenga un `platformId`
  de TikTok sin resolver en Mongo (o generando el caso con el flujo real
  contra la API real de TikTok, o revisando en Mongo un caso viejo si
  todavía existe). `frontend/` no cambia.

### Fase 1 — Campos nuevos + job de reconciliación (central)

- Modelos: `provisionalId`/`pendingConfirmation` + índice parcial (4.2,
  4.5) en `PlatformVideoModel`/`UploadHistoryModel`.
- Nuevo endpoint `POST /api/sync/history/pending` (4.4).
- `resolvePendingTikTokIds` migrado a filtrar por `pendingConfirmation`
  + reconciliar por `_id` (4.3).
- Job `scheduleTikTokReconciliation` (3.3), registrado en `server.ts`.
- **Verificable sin build de iOS**: todo el flujo se puede probar
  end-to-end contra la central real solo con `curl`/Postman simulando lo
  que un cliente mandaría a `/api/sync/history/pending`, más una cuenta de
  TikTok real conectada para que el job pueda de verdad resolver un
  `publish_id` pendiente. `npx tsc --noEmit` en `backend/` para confirmar
  que no se agregan errores nuevos (mismo criterio que ya se usa en
  `BUG-2026-08-15-02`, que reporta "27 preexistentes, ninguno nuevo" como
  vara de éxito).

### Fase 2 — iOS: persistir `publish_id` + `resume()` (mayor riesgo/esfuerzo)

- `TikTokUploader.swift`: nuevo `resume(publishId:onProgress:)` (2.2),
  nuevo callback `onOperationCommitted` (2.1), distinción `FAILED`
  confirmado vs. no confirmado (2.3).
- `PublishFormView.swift`: `PlatformPublishState` con
  `providerOperationId`/`bytesCommitted` (2.1), `performUpload` con la
  rama de resume (2.2), reporte a `POST /api/sync/history/pending` desde
  `UploadCoordinator` (4.4) en cuanto se comprometen los bytes.
- **Requiere build real en Xcode** — no se puede verificar compilando
  desde este entorno (Windows, ver trampas de entorno en
  `UIEssePanel/CLAUDE.md`). Camino ya usado en el repo: pedirle al usuario
  que lo compile en Xcode, o usar el acceso SSH a `macgessemberg22`
  documentado en la memoria de sesión `ios_ssh_build` (`xcodebuild` real,
  sin depender de que el usuario abra Xcode a mano). El comportamiento en
  sí (que un `publish_id` recuperado de `UserDefaults` efectivamente
  resuma sin resubir) solo se confirma con una publicación real a TikTok
  que se interrumpa a propósito (forzar background durante el polling) y
  challenging manual — no hay forma de simular esto sin la app corriendo
  de verdad en un dispositivo/simulador con red real a `open.tiktokapis.com`.

### Fase 3 — Android: mismo patrón que Fase 2 (fuera de alcance detallado de este documento)

- `TiktokUploader.kt` gana un `resume(publishId:)` análogo; `UploadWorker`
  necesita persistir el `publish_id` en algún lado que sobreviva un
  reintento manual (Room, dado que ya usa Room para
  `PlatformVideoRepository`, es candidato natural — no evaluado en
  profundidad acá).
- **Mismo problema de build que iOS**: no se puede compilar Gradle desde
  este entorno Windows (`UIEssePanel/CLAUDE.md`, bug conocido de
  Claude Code con procesos hijos JVM) — requiere que el usuario corra
  `./gradlew` desde Android Studio o una terminal normal.

### Fase 4 — Extender el mismo patrón a Instagram/YouTube (opcional, menor prioridad)

- Ver sección 1.5: el riesgo existe pero está acotado a una ventana mucho
  más chica (una sola llamada HTTP, no minutos de polling). Se anota como
  mejora de defensa en profundidad, no como bug activo — no se diseña en
  detalle en este documento.

### Qué NO cambia en ningún punto de este plan

- El formato/contrato del historial que ya consumen Electron/web/Android
  (`GET /api/sync/history`) no cambia — los campos nuevos
  (`provisionalId`/`pendingConfirmation`) son internos a la central, no se
  exponen en la respuesta de `getUploadHistory` salvo que se decida
  mostrar "publicación en curso" en el futuro (fuera de alcance).
- `applyPlatformPublish` sigue siendo la única fuente de verdad para
  "esto se publicó" — el flujo nuevo de `pendingConfirmation` es un estado
  previo a eso, no lo reemplaza.
