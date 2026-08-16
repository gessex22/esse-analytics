> **Estado (actualizado 2026-08-16): Fase G (ex-"subida ad-hoc") pausada sin
> implementar. La Opción C — la secundaria como cliente LAN de la primaria,
> igual que mobile — es la alternativa preferida para retomarla, y ya tiene
> una primera implementación en la rama `feat/electron-lan-client-secondary`
> (sin mergear a `main`).** No la des por "hecha" todavía: está implementada
> y validada por el contrato HTTP (ver "Opción C — implementación real"
> más abajo para el detalle exacto de qué se probó y con qué método), pero
> **sin probar con dos PCs físicas reales en la misma LAN** — falta esa
> prueba antes de considerarla lista para mergear. Las secciones 1-5
> originales de más abajo quedan como el razonamiento que llevó a la
> decisión de gate duro + Fase G, no las releas como si aún estuvieran
> abiertas tal cual. **El plan de implementación fase por fase de las Fases
> A-E (instalación primaria única, `requirePrimaryDevice`, `primaryDeviceId`,
> banner "Reclamar como principal") vive en
> `docs/primary-install-implementation-plan-2026-08-14.md`** — esas fases
> están implementadas y son ORTOGONALES a la Opción C descrita acá abajo,
> no la tocan ni dependen de ella.

# Plan: una sola instalación local "escritora" por cuenta

Alternativa al diseño de `canonical_content_id` + `content_hash`
(`docs/mongo-remediation-review-2026-08-13.md`), propuesta en conversación
2026-08-14. En vez de resolver la divergencia de `content_id` entre
instalaciones con un sistema de identidad nuevo, la elimina de raíz:
**solo una instalación por cuenta puede generar identidad de archivos**
(escanear disco, mintear `content_id`, hacer `fullSync`). El resto se
comporta como el modo remoto/web ya se comporta hoy.

## Por qué es viable

`User.installId` (central, `backend/src/models/user.model.ts:27`) ya es
**singular**, con este comentario explícito: *"Secreto único de la
instalación vinculada a esta cuenta ... Solo la instalación dueña conoce
este valor."* `video_folder` en el mismo modelo también es singular. No hay
`teamId`/`linkedAccounts`: cada `username` (incluido `role: editor`) es una
cuenta independiente con su propio `userId`, su propia carpeta, su propio
`installId`. El esquema ya asume "una PC dueña por cuenta" — este plan
formaliza esa asunción para el catálogo de archivos, no inventa una nueva.

También ya existe el precedente funcional: `secondary_install`
(`local-backend/src/controllers/backup-sync.controller.ts:44,432-435`) y el
banner "Esta no es tu PC principal" (`frontend/src/App.tsx:722-754`). Hoy
es solo un aviso informativo + un flag que desactiva `fullSync` — este plan
lo convierte en la restricción real.

## 1. ¿Se puede no impedir la subida de archivos desde la secundaria?

Sí — son dos niveles de restricción distintos, y conviene separarlos en vez
de ir directo al más duro:

**Opción A — gate duro (igual que el modo remoto/web hoy).** La
instalación no-primaria no puede configurar `video_folder` ni escanear
disco. `LOCAL_ONLY_NAV` (Videos, Subir, Taller, Gemas) se oculta igual que
en remoto. Cero código nuevo de identidad — reusa el mismo camino que ya
existe para `isLocal === false`. Contra: pierde la capacidad de publicar
subiendo bytes físicos desde esa PC (mismo límite que remoto tiene hoy).

**Opción B — adopción de identidad (recomendada, responde directo a tu
pregunta).** La secundaria **conserva** su carpeta, su escaneo, su
capacidad de publicar — nada de eso cambia. Lo único que cambia es un paso
en el `pull()`/escaneo: antes de mintear un `content_id` nuevo para un
archivo, o al recibir el catálogo de la nube, si hay un documento central
para el mismo `file_name` con un `content_id` ya establecido, **la
secundaria adopta ese `content_id` en su propia fila SQLite** en vez de
insistir con el suyo. Como además ya está aplicado C3 (la central nunca
pisa un `content_id` existente con uno entrante), el resultado converge
solo: la primera instalación que estableció el `content_id` para un archivo
gana, y todas las demás terminan alineadas con ella tras el próximo
`pull()`. Cambio acotado a `local-backend/src/controllers/backup-sync.controller.ts`
(la función de pull, alrededor de la línea 213-263 donde ya se comparan
`cf`/`localFile`) — nada de Mongo, nada de mobile.

Con B, "primaria" deja de significar "la única que puede tocar archivos" y
pasa a significar "la que gana los empates de identidad" — más parecido a
lo que ya hace `secondary_install` con `fullSync` hoy, solo que aplicado a
`content_id` en vez de a la reconciliación.

## 2. Reasignar PC principal

Reusa `User.installId` en vez de crear un campo nuevo:

1. Cuenta nueva (nunca configuró nada): `installId` queda null hasta que
   una instalación configura `video_folder` y hace su primer push exitoso
   — esa se auto-reclama primaria. Cero fricción para el caso normal de
   una sola PC (el 100% de los casos reales medidos hoy: 1 de 17 usuarios
   con datos, ese único con una sola instalación activa).
2. Nuevo endpoint `POST /api/local/claim-primary` (central): setea
   `user.installId = <installId de esta instalación>`. Requiere
   confirmación explícita en el frontend ("¿Esta PC reemplaza a tu PC
   principal? La anterior vas a poder seguir usándola en modo lectura").
3. **Sin necesidad de que la vieja primaria "se entere" en el momento**: en
   cada push/pull, `local-backend` manda su propio `installId` y la central
   contesta si coincide con `user.installId`. Si no coincide, esa
   instalación se auto-degrada a secundaria (opción A o B según lo que se
   elija en el punto 1) la próxima vez que sincroniza — offline hasta
   entonces, sin romper nada mientras tanto.
4. El único caso no resuelto solo: dos instalaciones reclamando primaria
   *al mismo tiempo* sin conexión entre sí — el último `claim-primary` que
   llega a la central gana, sin merge. Aceptable: es una acción explícita
   del usuario, no algo que pase por accidente.

## 3. ¿Cómo quedan los registros de video?

**Sin cambios de esquema en Mongo.** Ni `files` ni `backup_files` necesitan
campos nuevos — esto se resuelve enteramente en `local-backend` (Opción B)
o en gating de frontend/rutas (Opción A). El único campo nuevo es
`User.installId` pasando de "secreto de seguridad" a también "árbitro de
identidad", que ya existe.

Bonus importante: con un solo escritor de `content_id` por cuenta, la
divergencia que bloqueaba el índice único parcial de `content_id`
(`docs/mongo-remediation-review-2026-08-13.md`, hallazgo H8) deja de poder
ocurrir *por diseño* — no hace falta esperar tanto para retomar ese índice.
Sigue haciendo falta C4 (precedencia con `file_name` en `backup_files`) y
probar con clientes reales, pero el problema de fondo que lo bloqueaba
queda resuelto por este plan, no solo mitigado.

## 4. ¿Cómo se matchean los videos ya publicados en plataformas para una instalación nueva?

Esto **ya existe** y no hace falta tocarlo — es el mismo mecanismo que ya
corre para cualquier reconstrucción de catálogo desde cero (reinstalación,
wipe, etc.), no algo específico de "reasignar primaria":

- El `pull()` (`backup-sync.controller.ts`) trae `platformvideos`/
  `upload_history` ya matcheados por `content_id` o `file_name` contra la
  central — los badges/links se reconstruyen solos si los nombres
  coinciden.
- Para lo que no matchea automático, existe "Emparejar" en Sincronizar
  (`crossMatchGroupId` en `platformvideos`, `sync.controller.ts:203-270`,
  expuesto también en iOS vía `SyncAPI.crossMatchCandidates`) — matching
  manual asistido para el resto.

Osea: al reclamar una PC como nueva principal, correr el flujo normal de
`pull()` + escaneo de la carpeta alcanza. No hace falta un flujo especial
de "primera vez".

## 5. ¿Qué pasa si se borran los archivos base en la PC?

También ya existe, sin cambios necesarios:

- El scan local ya detecta un archivo tracked que desapareció del disco y
  lo marca `status: 'ELIMINADO_DISCO'` (`local-backend/src/controllers/scan.controller.ts:113-117`).
- El próximo push con `fullSync` (solo la primaria lo hace) propaga ese
  estado a la central (`bulkUpsertBackupFiles`, la reconciliación al final
  de la función) — preserva metadata/historial/transcripciones, pero los
  bytes físicos ya no existen en ningún lado salvo que ese video
  específico se haya subido a Biblioteca remota (premium + storage plan,
  con tope).

**Esto es justo el motivo por el que la elección de primaria importa**: la
PC principal es un punto único de falla para los bytes físicos, con o sin
este plan — no es un riesgo nuevo que este diseño introduzca, pero si se
implementa, vale la pena que el flujo de "reclamar primaria" (punto 2)
avise esto explícitamente en vez de dejarlo implícito.

## Decisión final (2026-08-14): Opción A + subida simple ad-hoc

Se descartó la Opción B (adopción de `content_id`). Se eligió el gate duro,
resolviendo su contra principal (perder la capacidad de publicar desde la
secundaria) con un flujo nuevo y acotado, no con el mecanismo de identidad
de B.

### Qué es el gate duro en concreto

Una instalación no-primaria (`installId` local ≠ `User.installId` central):
- No puede configurar `video_folder` ni correr `watcher.ts`/`scan.controller.ts`.
- `LOCAL_ONLY_NAV` (Videos, Subir catálogo completo, Taller, Gemas) se oculta,
  igual que en modo remoto hoy.
- El SQLite local **sigue existiendo** (el gate es sobre el escaneo de
  carpeta persistente, no sobre la base en sí) — necesario para lo que
  sigue.

### Hallazgo técnico que definió el diseño de "subida simple"

Los 3 uploaders de `local-backend` (`youtube-upload.controller.ts:151`,
instagram/tiktok equivalentes) **exigen un `fileId` de SQLite**
(`fileRepo.findById(fileId)`) — no existe hoy ningún endpoint que reciba un
archivo suelto sin pasar antes por el catálogo. La "Subida simple" actual
(`frontend/src/components/SimpleUploadView.tsx`) tampoco sirve tal cual:
depende de `videoService.getSlimList()`, que lee el catálogo trackeado —
con el gate puesto, esa lista queda vacía.

### Flujo nuevo: subida simple ad-hoc (a construir)

1. El usuario elige **un** archivo con el picker nativo del SO — no desde
   una carpeta trackeada.
2. `local-backend` de esa PC lo copia a un temporal propio y crea **una
   sola fila** `fileRepo.create()` para ese archivo puntual. Como es un
   video nuevo (no existe en ningún lado más), no hay conflicto de
   identidad posible — el `content_id` que le toque es irrelevante, nunca
   compite con nada (ver "Video nuevo en la secundaria" abajo).
3. Con ese `fileId` ad-hoc, reusa el 100% de los uploaders existentes sin
   tocarlos — publica en 1-3 plataformas con título/descripción
   compartidos, mismo UX que la `SimpleUploadView` actual.
4. Al terminar, borra el temporal (opcional) — el video real queda en las
   plataformas, no como catálogo persistente en esa PC.

### Cómo se ve en el resto del sistema

- **Historial**: sin cambios. Cada uploader llama `recordUploadEvent`/
  `applyPlatformPublish` al terminar, sin importar qué PC lo originó —
  aparece en Historial normal.
- **¿La PC principal la detecta?**: sí, vía su próximo `pull()`. La central
  ya tiene un `files` doc (creado por `resolveOrCreateFile`,
  `backup.controller.ts:734-740` — el mismo camino que usa hoy cualquier
  publicación desde el celular sin catálogo local previo). La primaria lo
  trae como metadata/badge en el próximo pull, sin bytes. **No hace falta
  construir nada nuevo acá.**
- **Estadísticas**: sin cambios — se calculan sobre `platformvideos`
  (métricas reales de la API de cada plataforma), no sobre qué máquina
  subió el archivo.
- **Transcripción y miniatura**: limitación real, pero **preexistente, no
  una regresión de este plan** — es la misma que ya tiene hoy cualquier
  video publicado solo desde el celular. Sin catálogo local persistente:
  no hay transcripción (100% local, corre sobre el archivo en disco) y la
  miniatura sale placeholder en la primaria (se genera con ffmpeg sobre el
  archivo local, que ahí no existe). Mejora opcional para más adelante:
  como el archivo sí pasa físicamente por la secundaria durante el upload,
  se podría generar la miniatura en ese momento (el ffmpeg de
  `local-backend` ya está disponible) y pushearla a la central junto con
  el registro. La transcripción queda fuera de alcance (necesita el modelo
  completo, más caro).

### Video nuevo en la secundaria (ya cubierto, sin caso especial)

Un video que no existe en ningún lado (ni central, ni Nube, ni otra PC) no
tiene con qué entrar en conflicto — el gate de identidad "primaria vs
secundaria" solo importa cuando hay dos identidades compitiendo por el
mismo archivo. La subida simple ad-hoc de arriba cubre este caso sin
ninguna lógica adicional.

### Video que ya está en Biblioteca remota (Nube) — no cubierto todavía

No existe hoy en Electron el equivalente de
`ImportUseCase.swift::importFromRemoteLibrary` (iOS) — descargar bytes de
Nube a un temporal, importar, publicar. Si hiciera falta publicar desde una
secundaria algo que **ya** está en Nube sin tenerlo físicamente ahí,
habría que construir esa feature aparte (mismo patrón que mobile), usando
`remoteLibraryVideoId` como identidad — no `content_id` — igual que ya
hace mobile. No es parte de este plan; queda anotado como posible trabajo
futuro si se necesita.

## Pendiente de decidir/hacer antes de implementar

- Diseñar el flujo UI/UX de "reclamar PC principal" (punto 2) y el picker
  nativo de la subida simple ad-hoc.
- Confirmar que ningún flujo actual depende de que **dos** instalaciones
  hagan `fullSync` a la vez (no encontré ninguno revisando `sync.routes.ts`/
  `backup.routes.ts`, pero vale la pena que lo confirme quien lo implemente).
- Decidir si la mejora opcional de miniatura-en-upload-ad-hoc entra en el
  alcance inicial o se deja para después.

> **Actualización 2026-08-16**: lo de arriba (picker nativo + subida ad-hoc)
> era el plan para la Fase G. Sigue siendo válido como fallback, pero abajo
> hay una alternativa evaluada que lo supera en experiencia — ver "Opción C".
> Fases A-E (quién es la primaria, gate `requirePrimaryDevice`, banner
> "Reclamar como principal") **ya están implementadas y pusheadas**
> (`ab3051d`, `46bce3b`, ver `docs/HANDOFF-mongo-y-primaria-2026-08-14.md`)
> — nada de esto las toca ni las reemplaza, son ortogonales. Esto es
> específicamente sobre qué hace una secundaria una vez que el gate ya la
> identificó como tal (Fase G, sin arrancar todavía).

## Opción C (evaluada 2026-08-16): la secundaria como cliente LAN de la primaria, igual que mobile

Propuesta del usuario en conversación: en vez de que la secundaria suba UN
archivo suelto sin catálogo (Fase G tal como estaba diseñada), que **ni
siquiera use su propio local-backend para la biblioteca compartida** — que
apunte su frontend, vía LAN, directo al local-backend de la PC primaria, y
listo. Exactamente el patrón que `essenalytics-ios` ya construyó y probó
para su modo "PC local" (`ServerSettingsView.swift`/`PCLocalPublishView.swift`,
agregado 2026-08-15) — reusar un contrato ya validado en vez de inventar uno
nuevo y más pobre.

### Por qué es mejor que la subida ad-hoc para Fase G

| | Subida ad-hoc (plan original de Fase G) | Opción C — cliente LAN |
|---|---|---|
| Qué ve la secundaria | Nada — solo un picker de archivo suelto del SO | El catálogo real y completo de la primaria (Videos, Subir, con reproductor y todo — desktop ya tiene UI rica, a diferencia de la versión reducida que hubo que construir para mobile) |
| Miniatura/transcripción | No hay (archivo no persiste en catálogo trackeado) | Sin problema — los bytes siguen viviendo solo en la primaria, que es quien ya genera todo eso |
| Trabajo nuevo del lado servidor | Ninguno (reusa los 3 uploaders vía `fileId` efímero) | Ninguno — el local-backend de la primaria ya expone `GET /api/videos`, thumbnail, stream, los 3 endpoints de upload; es el MISMO contrato que ya consume `LocalBackendUploadAPI.swift` en iOS |
| Trabajo nuevo del lado cliente | Nuevo endpoint + flujo de picker+upload temporal | `API_BASE` (`frontend/src/config.ts:12`) deja de ser fijo a `window.location.origin` — necesita un override persistido, igual que `CentralAPI.customServerURLString`/`ServerPresetStore` en iOS. Más una pantalla de selección de servidor en Electron (puede reusar el descubrimiento Bonjour que `electron/src/main.ts` YA anuncia — es el mismo servicio `_esseanalytics._tcp` que `LocalPCDiscovery.swift` ya consume del lado iOS, cero trabajo nuevo de descubrimiento) |
| Login antes de sesión | No aplica (la secundaria ya tiene su propia sesión) | Mismo problema que iOS ya resolvió (loguearse contra un servidor elegido, no el de siempre) — reusar el mismo patrón, no inventarlo |

### Qué falta para validar esto de verdad

1. Confirmar que las rutas de `local-backend` que consumiría la secundaria
   (`GET /api/videos`, stream, thumbnail, los 3 `/upload`) no asumen en
   ningún lado "quien pega este request es la misma máquina" — deberían
   estar bien (ya las consume el celular por LAN sin problema), pero vale
   la pena que quien implemente lo verifique explícitamente.
2. Decidir qué pasa con el local-backend BUNDLADO de la secundaria en este
   modo — sigue corriendo igual (Electron siempre lo levanta), simplemente
   el frontend no le habla a él para la biblioteca compartida. Confirmar
   que no hay otro código que asuma que `API_BASE == mi propio backend`
   (ver `frontend/src/services/api.ts`, además de las URLs de
   thumbnail/stream/tus ya listadas en ese archivo).
3. Diseñar la pantalla de selección de servidor en Electron/Ajustes (mirror
   de `ServerSettingsView.swift`) — no existe hoy, el desktop nunca tuvo
   necesidad de esto porque siempre hablaba consigo mismo.

**Recomendación**: si se retoma Fase G, evaluar Opción C como reemplazo
directo del plan de "subida ad-hoc", no como alternativa a discutir en
paralelo — da mejor experiencia con una cantidad de trabajo nuevo
comparable, reusando infraestructura (Bonjour, contrato HTTP) ya construida
y probada en producción por mobile.

## Opción C — implementación real (2026-08-16, rama `feat/electron-lan-client-secondary`)

Lo de arriba quedó implementado. Resumen honesto de qué se construyó, qué se
probó de verdad (y con qué método) y qué sigue pendiente de hardware real —
ver también el reporte de la sesión que lo hizo para el detalle completo.

### Qué se construyó

- **`frontend/src/config.ts`**: `API_BASE` ahora puede tener un override
  persistido en `localStorage` (`IS_LAN_CLIENT`, `setServerOverride`),
  con `window.location.origin`/central como default si no hay override.
  Cambiarlo fuerza un reload (mismo criterio que `CentralAPI` en iOS: no es
  reactivo en caliente).
- **`frontend/src/components/ServerConnectionPanel.tsx`** (nuevo): selector
  "Esta PC" / "Otra PC en la red", con descubrimiento Bonjour vía IPC,
  campo manual de IP:puerto, y test de conexión real contra
  `GET /api/local/health` antes de aplicar el override. Conectar con éxito
  borra el token guardado (JWT de un backend no vale para otro) y recarga.
  Montado en dos lugares, igual que `ServerSettingsView.swift`: Ajustes >
  Servidor (con sesión, `SettingsView.tsx`) y un modal desde `LoginPage.tsx`
  (sin sesión — resuelve el mismo problema que iOS ya tuvo: loguearse contra
  el servidor elegido antes de tener token).
- **`electron/src/main.ts`/`preload.ts`**: nuevo `ipcMain.handle('bonjour:discover')`
  que busca el servicio `_esseanalytics._tcp` (el mismo que ya se anuncia)
  durante 3s y devuelve lo encontrado; expuesto como
  `window.electronAPI.discoverServers()`.
- **`frontend/src/hooks/useServerReachability.ts`** (nuevo): poll a
  `GET /api/health` cada 15s, SOLO activo si `IS_LAN_CLIENT` — banner en
  `App.tsx` si la primaria deja de responder (pérdida de conexión/WiFi/PC
  apagada), en vez de un spinner colgado o un fallo silencioso por vista.
- **`App.tsx`/`SettingsView.tsx`**: en modo cliente LAN se oculta lo que
  depende del DISCO de esta instalación puntual (banner "configurá tu
  carpeta", banner "PC no principal", el chequeo de `installationRole` de
  las Fases A-E — ortogonal, no se reemplaza ni se toca —, y las secciones
  de Ajustes "Biblioteca"/"Datos locales"/"Remoto y Backup", que si se
  usaran acá operarían sobre el disco/SQLite de la PC PRINCIPAL, no de
  quien mira la pantalla). El catálogo, reproductor, Subir, Taller y Gemas
  siguen visibles normalmente — `isLocal` sigue dando `true` porque la
  primaria SÍ es un local-backend real.

### Qué se validó de verdad, y cómo

Sin 2 PCs físicas disponibles en este entorno, se usó la técnica descrita
en el pedido original: 2 `local-backend` en puertos distintos en la misma
máquina, uno de ellos ("primaria") con una carpeta de prueba con un archivo
de video sintético.

- `npm run lint` y `npm run build` de `frontend/` limpios con el código nuevo.
- `npx tsc -p tsconfig.json --noEmit` de `electron/` limpio (incluye el
  handler de Bonjour nuevo).
- `local-backend` real (no central, no lab) levantado en un puerto aislado
  (**nunca el 4000 real** — se detectó por accidente que ese puerto tenía la
  instalación real de EsseAnalytics de este equipo corriendo, ver nota de
  seguridad abajo), con un JWT firmado a mano con el mismo `JWT_SECRET` que
  se le pasó al proceso (esto se salta el login real contra la central, que
  no está disponible en este entorno — no valida el login en sí, que es
  preexistente y no toca este cambio).
- Con eso, confirmado con `curl` simulando un origen HTTP distinto
  (`Origin: http://127.0.0.1:5555`, el mismo tipo de cross-origin que tendría
  el frontend de la secundaria):
  - `GET /api/local/health` sin token → responde `{local:true,...}`, exactamente
    lo que usa `ServerConnectionPanel` para el test de conexión.
  - `Access-Control-Allow-Origin: *` en todas las respuestas — confirma en la
    práctica lo que el plan original dejaba como "a confirmar": el `cors()`
    default de `local-backend/src/server.ts` SÍ es permisivo para cualquier
    origen, sin necesidad de proxear por IPC como contemplaba el punto 2 del
    "Qué falta para validar" de más arriba.
  - `POST /api/videos/scan/config` + `POST /api/videos/scan` sobre la carpeta
    de prueba → detecta el archivo (`scanned:1, added:1`).
  - `GET /api/videos` con token → devuelve el catálogo con el archivo recién
    escaneado.
  - `GET /api/videos/stream/:id` con `Range` → `206 Partial Content` con
    `Content-Range`/`Accept-Ranges` correctos y el mismo header CORS —
    confirma que el streaming del reproductor funciona cross-origin.
  - `GET /api/videos/:id/thumbnail` → `404` (esperado: el archivo de prueba
    es un binario sintético, no un video real que ffprobe pueda leer — no
    prueba la generación de miniatura en sí, solo que la ruta responde bien
    formada cross-origin).
  - `POST /api/youtube/upload` con un `fileId` real → `{"error":"NO_AUTH",...}`
    (esperado: sin cuenta de YouTube conectada en esta instalación de prueba)
    — confirma que el endpoint de publicación es alcanzable cross-origin y
    responde con el error de negocio correcto, no con un fallo de ruteo/CORS.
  - `GET /api/videos` sin token → `401 {"message":"Token requerido."}` — el
    gate de auth sigue aplicando igual hablando cross-origin.

  **Nota de seguridad de esta sesión (no un bug del código, un hallazgo del
  entorno de prueba)**: el primer intento de levantar un `local-backend` de
  prueba usó el puerto 4000 por default y, sin darse cuenta, coincidió con
  el puerto en el que ya estaba corriendo la instalación REAL de
  EsseAnalytics de esta máquina (`EsseAnalytics.exe`, confirmado con
  `netstat`/`tasklist` por PID). Un `POST` de prueba con JSON mal formado
  llegó a esa instancia real pero falló en el parseo del body ANTES de
  tocar ningún handler (sin mutación) — no se escribió nada en los datos
  reales del usuario. Se cortó esa prueba de inmediato y se rehizo entera
  en el puerto 47001, confirmado aislado con `netstat` antes de continuar.
  Vale la pena que quien retome esto en máquinas reales use puertos no-4000
  para cualquier prueba similar, o confirme primero que no hay una
  instalación real corriendo.

### Qué NO se validó (pendiente de hardware real, explícito)

- **Descubrimiento Bonjour cruzando dos máquinas físicas distintas en la
  misma red WiFi real.** El handler de `ipcMain.handle('bonjour:discover')`
  se revisó por lectura de código (mismo patrón que el `publish()` ya
  probado en producción por mobile) y compila, pero nunca se ejecutó de
  verdad — este entorno no tiene una ventana de Electron interactiva ni una
  segunda máquina en la misma LAN.
- **La ventana de Electron real corriendo la UI nueva** (`ServerConnectionPanel`,
  el modal en `LoginPage`, la sección "Servidor" en Ajustes) — se validó
  por lectura de código + que compila, no con clicks reales. Este entorno no
  puede lanzar Electron de forma interactiva/gráfica.
- **Pérdida de conexión real** (WiFi cayendo a mitad de sesión) — solo se
  probó el mecanismo de detección (`useServerReachability` pollea
  `/api/health`) por lectura de código; matar el proceso de un
  `local-backend` de prueba a mitad de operación (cubierto parcialmente por
  el punto de arriba sobre cerrar el puerto 47001) confirma que el poll
  detectaría un `ECONNREFUSED`, pero no se disparó el banner real en una UI
  corriendo.
- **Login end-to-end contra un servidor elegido** (el flujo completo:
  `ServerConnectionPanel` → conectar → `LoginPage` sin sesión → loguearse
  contra la central real a través de la primaria) — el JWT usado en las
  pruebas de arriba se firmó a mano para saltar la dependencia de la central
  real (no accesible desde este entorno), así que el contrato de rutas
  protegidas quedó validado pero NO el viaje completo de credenciales través
  del proxy `auth-proxy.routes.ts` de la primaria.
- **Publicación real** en YouTube/Instagram/TikTok desde una secundaria
  (se confirmó que el endpoint responde con el error de negocio esperado
  sin cuenta conectada, no que una subida real completa funcione).

### Siguiente paso recomendado

Antes de mergear: repetir la validación de arriba con dos instalaciones de
Electron reales en la misma LAN (o al menos dos ventanas de Electron en la
misma máquina, cada una con su propio `local-backend` empaquetado en
puertos distintos) — eso cubre Bonjour real y la UI real, que son
exactamente los dos huecos que este entorno no puede cerrar por sí solo.
