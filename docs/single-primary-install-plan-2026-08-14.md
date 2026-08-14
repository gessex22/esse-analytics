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

## Pendiente de decidir antes de implementar

- **Opción A vs B** (punto 1) — B preserva más funcionalidad pero es más
  código; A es casi gratis pero le saca a la secundaria la posibilidad de
  publicar subiendo bytes propios.
- Si se elige B, definir la señal exacta para "adoptar" el `content_id`
  central (¿alcanza con `file_name` igual, o conviene sumar
  tamaño/duración como hoy hace `findDuplicate` en iOS, para evitar
  adoptar la identidad de un archivo distinto que casualmente se llama
  igual — mismo caso límite que H9).
- Confirmar que ningún flujo actual depende de que **dos** instalaciones
  hagan `fullSync` a la vez (no encontré ninguno revisando `sync.routes.ts`/
  `backup.routes.ts`, pero vale la pena que lo confirme quien lo implemente).
