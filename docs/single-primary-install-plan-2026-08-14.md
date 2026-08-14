> **Estado: diseño decidido, con plan de ejecución escrito.** Se optó por
> Opción A (gate duro) + subida simple ad-hoc para no perder la capacidad de
> publicar desde una secundaria. Ver "Decisión final" más abajo para el
> detalle completo — las secciones 1-5 originales quedan como el
> razonamiento que llevó a la decisión, no las releas como si aún
> estuvieran abiertas. **El plan de implementación fase por fase, ya
> revisado y con una corrección de contrato aplicada, vive en
> `docs/primary-install-implementation-plan-2026-08-14.md`** — ese es el
> documento a seguir para implementar, no este.

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
