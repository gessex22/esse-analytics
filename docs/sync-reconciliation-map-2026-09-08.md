# Mapa de reconciliación — 6 hechos, ~11 representaciones (2026-09-08)

Auditoría de **solo lectura**. No se modificó código ni datos. Todo lo afirmado
acá va con `archivo:línea`; lo que no se pudo verificar está marcado como
**no verificado**.

## Por qué existe este documento

Los 6 bugs de propagación corregidos entre el 2026-09-05 y el 2026-09-07 no
fueron bugs de notificación ni de latencia: **los 6 son fallas de reconciliación
entre dos representaciones distintas del mismo hecho**. La hipótesis a validar
era que el problema no es la falta de una fuente de verdad (está decidida caso
por caso, en comentarios), sino que hay ~11 representaciones — decenas de pares
— y cada par tiene su regla escrita a mano en un `if` distinto; los bugs viven
en los pares sin regla.

**Resultado: hipótesis confirmada, y con un matiz que la agrava.** No solo faltan
reglas en algunos pares: hay pares donde **dos reglas correctas por separado se
componen en un ciclo que se auto-refuerza** (§7.1, §7.2). El mecanismo
push-antes-que-pull (`frontend/src/services/syncOrchestrator.ts:21-23`) es el
motor que convierte esos ciclos en reversiones deterministas, no en carreras
ocasionales.

---

## 1. Inventario de representaciones

### Central (Mongo) — 8 modelos + 2 colecciones sin modelo

| # | Colección | Modelo | Qué hecho guarda |
|---|---|---|---|
| C1 | `files` | `backend/src/models/file.model.ts` | badge (`platforms`, `platforms_discarded`, `platform_states`), `content_status`, `scheduled_date`, timestamps de sync |
| C2 | `platformvideos` | `backend/src/models/platform-video.model.ts` | link real (`platformId`/`platformUrl`), `publishedAt`, **métricas** (`views/likes/comments`), `linkedFileId`, `crossMatchGroupId` |
| C3 | `backup_files` | `backend/src/models/backup-file.model.ts` | badge + `content_status` + `scheduled_date` (espejo del push de la PC). **Sin `platform_states`** |
| C4 | `backup_platform_videos` | `backend/src/models/backup-platform-video.model.ts` | link real + `published_at` (espejo del push de la PC, lo que lee el pull) |
| C5 | `remote_library_videos` | `backend/src/models/remote-library-video.model.ts` | badge (`platforms`/`platformsDiscarded`/`platformStates`) + link real (`platformLinks[]`) de la cola en la nube |
| C6 | `upload_history` | `backend/src/models/upload-history.model.ts` | evento de publicación: link + `publishedAt` + `deviceId` + `operationId` (lote) |
| C7 | `published_cards` | `backend/src/models/published-card.model.ts` | "último publicado" por plataforma: link + `publishedAt` + **snapshot de métricas** (`stats`) |
| C8 | `audit_events` | `backend/src/models/audit-event.model.ts` | log append-only de `publish_confirmed` (con `operationId`) |
| C9 | `platform_config` | *(sin modelo — `db.collection('platform_config')`, `backup.controller.ts:925`)* | cola de calendario: `lastPublishedDate/Title`, `nextVideoId`, `nextRemoteLibraryVideoId` |
| C10 | `backup_configs` | `backend/src/models/backup-config.model.ts` | **segunda** copia de la cola de calendario (`platform_configs[]`), por `file_name` |

`publishing-status.model.ts` existe pero es legado (equivalente a la tabla
homónima de SQLite); no participa de ningún flujo de reconciliación actual.

### Escritorio (SQLite, `local-backend/src/db/database.ts`)

| # | Tabla | Líneas | Qué guarda |
|---|---|---|---|
| L1 | `files` | `database.ts:25-40` + migraciones `162-171` | `platforms`, `platforms_discarded`, `platforms_updated_at`, `content_status`, `scheduled_date`, `content_id` |
| L2 | `platform_videos` | `database.ts:52-65` | link real + `published_at` + `linked_file_id` + `match_status` |
| L3 | `publishing_status` | `database.ts:42-50` | legado (`youtube_published`…), solo backfill de arranque (`database.ts:222-241`) |
| L4 | `platform_config` | `database.ts:74-82` | cola de calendario local |
| L5 | `history_outbox` | `database.ts:140-158` | eventos de historial pendientes de entregar |

### Móviles

| # | Dónde | Archivo | Qué guarda |
|---|---|---|---|
| M1 | iOS SwiftData | `Core/Database/FileEntity.swift:31-32` | `platforms`, `platformsDiscarded` (**sin** `platformStates`, **sin** `contentId`, **sin** `platforms_updated_at`) |
| M2 | iOS SwiftData | `Core/Database/PendingPlatformUpdate.swift:17-41` | outbox del badge, por `fileName` |
| M3 | Android Room | `core/database/.../entity/FileEntity.kt:17-18` | ídem M1 (CSV en vez de array) |
| M4 | Android Room | `entity/PendingPlatformUpdateEntity.kt` | outbox del badge |
| M5 | iOS `UserDefaults` | `Features/Upload/PublishFormView.swift:76,689-703` | lote de publicación en curso (**una sola clave global**) |
| M6 | Android DataStore | `core/datastore/PendingBatchStore.kt:32-64` | lote en curso (**una sola clave**, `KEY_BATCH`) |

**El hecho "este video está publicado en TikTok con este link" es escribible en
C1, C2, C3, C4, C5, C6, C7, L1, L2, M1, M3 — 11 representaciones.** La
verificación preliminar del encargo queda confirmada, y con dos representaciones
extra que no estaban contadas: `platform_config` (C9) y `backup_configs` (C10)
guardan una proyección del mismo hecho ("qué fue lo último publicado acá").

### Vocabulario divergente entre representaciones (causa directa de BUG-2026-09-07-02)

| Representación | Plataformas admitidas |
|---|---|
| C1 `files.platforms` | youtube, instagram, tiktok, **facebook** (`file.model.ts:13,73`) |
| C2 `platformvideos.platform` | youtube, instagram, tiktok, **facebook** (`platform-video.model.ts:5,52`) |
| C5 `remote_library_videos` | youtube, instagram, tiktok (**sin** facebook, `remote-library-video.model.ts:4,56,72`) |
| C3/C4 | `[String]` sin enum — acepta cualquier cosa |
| M1 iOS `Platform` | youtube, instagram, tiktok (**sin** facebook, `Core/Model/Platform.swift:4-7`) |
| M3 Android `Platform` | youtube, instagram, tiktok, **facebook** (`core/model/Platform.kt:9`) |

iOS sobrevive a `facebook` solo porque `BackupFileDTO` lo decodifica como
`[String]` crudo en vez de un enum (`Core/Network/DTOs/BackupDtos.swift:13-22`,
con el comentario que documenta el incidente). BUG-2026-09-07-02 fue exactamente
esto en el lado central: un conteo que sumaba `facebook` como una 4ª plataforma
"decidida" (corregido en `sync.controller.ts:392-405`).

---

## 2. Hecho 1 — Badge de plataforma (`platforms` / `platforms_discarded` / `platform_states`)

### 2.1 Dónde vive y quién escribe

| Repr. | Escritores |
|---|---|
| C1 `files` | `bulkUpsertBackupFiles` (`backup.controller.ts:399-466`), `updateFilePlatforms` (`:1041-1044`), `applyPlatformPublish` (`:1173-1178`), `unlinkPlatform` (`sync.controller.ts:171-175`), `updateRemoteLibraryVideoPlatforms` (`remote-library.controller.ts:648-654`), uploaders (`youtube-upload.controller.ts:280` etc.) |
| C3 `backup_files` | **solo** `bulkUpsertBackupFiles` (`:322-371`) |
| C5 `remote_library_videos` | `updateRemoteLibraryVideoPlatforms` (`remote-library.controller.ts:509-546`), `applyPlatformPublish` (`backup.controller.ts:1257-1283`), `bulkUpsertBackupFiles` vía `mergeRemoteResolutionDelta` (`:526-545`), `updateFilePlatforms` (`:1059-1065`) |
| L1 SQLite | `fileRepo.update/addPlatform/removePlatform/resolveOthersAsDiscarded` (`file.repo.ts:255-341`); entry points: `updateVideoPlatforms` (`local video.controller.ts:208-242`), `setPlatformLink` (`:312-387`), `updateVideosBulk` (`:390`), `pullFromCloud` (`backup-sync.controller.ts:355-377`), `pullPlatformVideosFromCloud` (`:447-449`) |
| M1/M3 | `FileEntity.addPlatform/removePlatform/resolveOthersAsDiscarded` (`FileEntity.swift:96-128`) + `SyncAPI.updateFilePlatformsOrEnqueue` (`SyncAPI.swift:331`) |

`platform_states` (el "estado explícito": `confirmed` / `badge_only` /
`discarded`) existe **solo en C1 y C5**. Sus reglas de transición están en un
único lugar — `backend/src/utils/platform-state.util.ts:36-67` — que es el mejor
ejemplo del sistema de "una regla escrita una sola vez". La regla dura:
`confirmed` nunca se degrada (`platform-state.util.ts:41,47`).

### 2.2 Reglas por par

| Par | Regla actual | Código |
|---|---|---|
| L1 → C3 | LWW por `local_updated_at`, **más** "incoming vacío nunca pisa un existente con datos" | `backup.controller.ts:311-320` + `resolvePlatforms` `:294-309` |
| L1 → C1 | **Sin LWW.** Se escribe sobre `incoming` completo, no sobre `toUpdate` | `backup.controller.ts:399-400` |
| L1 → C1 (protección) | "una plataforma `confirmed` nunca sale de `platforms` ni entra a `platforms_discarded`" | `backup.controller.ts:419-425` (fix de BUG-2026-09-06-04) |
| C1+C3 → L1 | LWW dedicado por `platforms_updated_at`; si falta en cualquiera de los dos lados, **la nube gana** | `backup-sync.controller.ts:330-335` |
| C1 → C3 (en lectura) | Si difieren, gana C1 y se le presta su `updatedAt` como `local_updated_at` | `backup.controller.ts:96-108` |
| M1/M3 → C1 | `$set` duro de los dos arrays + `deriveStatesFromToggle` (nunca degrada `confirmed`) | `backup.controller.ts:1040-1044` |
| C1 → C5 | Solo altas (delta), nunca bajas; descarte no degrada `confirmed` | `remote-library-platform-sync.service.ts:24-52`, invocado en `backup.controller.ts:526-545` |
| C5 → C1 | Solo lo que C1 no tiene todavía en NINGUNO de los dos arrays | `remote-library.controller.ts:637-638` |
| C1 → M1/M3 | **NINGUNA — no existe la dirección** (§2.3) | — |
| C1 → C3 (`platform_states`) | **NINGUNA** — C3 no tiene el campo | `backup-file.model.ts:3-24` |

### 2.3 Pares sin regla (badge)

1. **C1 → M1/M3: no existe.** El único escritor de `FileEntity.platforms` en iOS
   es el propio usuario del teléfono; `SyncAPI.updateFilePlatforms` solo empuja
   (`LocalVideoDetailAdapter.swift:97` es su único caller). El catálogo central
   se muestra en móvil como una **lista aparte** (`.backupCatalog`,
   `LibraryListItem.swift:47`), nunca se fusiona con `FileEntity`. Consecuencia:
   un video importado al teléfono y publicado desde la PC queda marcado
   "pendiente" para siempre en la biblioteca on-device.
2. **`platform_states` no se escribe nunca desde el escritorio.**
   `bulkUpsertBackupFiles` no lo incluye en su `$set` (`backup.controller.ts:432-459`)
   y el frontend/local-backend **no llaman nunca** a `POST /api/sync/file-platforms`
   (verificado: los únicos hits del string en el repo del dashboard son la
   definición del endpoint y su ruta). Solo iOS/Android lo alimentan. Así,
   `platform_states` describe el estado real solo para lo que pasó por
   `applyPlatformPublish` o por un móvil.
3. **C3 nunca recibe `platform_states`** — y sin embargo, en el pull, es C3 quien
   aporta el timestamp de desempate (§7.2).
4. **`unlinkPlatform` no toca `platform_states`** (`sync.controller.ts:171-175`:
   `$pull` sobre `platforms`/`platforms_discarded` y nada más) — ver §7.1.

---

## 3. Hecho 2 — Link real de publicación (`platformId` / `platformUrl`)

### 3.1 Dónde vive

C2 (`platformvideos`), C4 (`backup_platform_videos`), C5
(`remote_library_videos.platformLinks[]`), C6 (`upload_history`), C7
(`published_cards`), L2 (`platform_videos` SQLite). Seis representaciones del
mismo par (video, plataforma) → (id, url).

`applyPlatformPublish` (`backup.controller.ts:1083-1286`) es el punto que
pretende ser único: su docblock (`:1071-1082`) enumera explícitamente las 5
colecciones que deja consistentes. **Es genuinamente el mejor punto del sistema.**
Los huecos están en los caminos que no pasan por él.

### 3.2 Reglas por par

| Par | Regla | Código |
|---|---|---|
| publish → C2 | `$set` del link, `publishedAt` en `$setOnInsert`; se desvincula el doc viejo con otro `platformId` | `backup.controller.ts:1212-1240` |
| publish → C4 | `$set` completo, incluido `published_at` (**no** `$setOnInsert`) | `backup.controller.ts:864-881` |
| publish → C6 | `$set` + `publishedAt` en `$setOnInsert` | `backup.controller.ts:1332-1351` |
| publish → C5 | merge por plataforma (reemplaza el link de esa plataforma, conserva los demás) | `backup.controller.ts:1266-1278`, `remote-library.controller.ts:517-523` |
| L2 → C4 | **Sin LWW: cualquier push gana siempre.** Se manda `local_updated_at` pero nunca se compara | `backup.controller.ts:809-835` (mecanismo exacto de BUG-2026-09-07-01) |
| C4 → L2 | "el no-vacío gana": `platform_url`/`published_at`/`linked_file_id` caen a `existing` si el entrante es null | `platform-video.repo.ts:142-153` |
| C6 → C2 | reaplicar solo eventos "huérfanos" (sin ningún `PlatformVideoModel` por `platformId`, ni por `contentId`, ni por `fileName`) | `backup.controller.ts:752-791` |
| C2 → C6 | solo para la corrección de ids de TikTok | `sync.controller.ts:650-663` |
| C2 → C7 | en lectura: gana el `publishedAt` más nuevo entre espejo y C2 | `published-cards.controller.ts:61-63` |
| L2 → C7 | **Sin regla:** el mirror del escritorio pisa incondicionalmente | `published-cards.controller.ts:160-183` |

### 3.3 Pares sin regla y direcciones faltantes (link)

1. **L2 → C4 no tiene ninguna protección** (documentado como pendiente en
   BUG-2026-09-07-01, `docs/bug-reports.md:212-216`). Es el único par de esta
   familia donde el escritor menos informado (la SQLite de una PC, que puede
   estar días atrasada) gana siempre contra una corrección central hecha por
   `resolveCrossMatchSlot`.
2. **`match_status` degrada en el pull.** `pullPlatformVideosFromCloud` pasa
   `cv.match_status ?? 'sin_match'` (`backup-sync.controller.ts:433`) y
   `platformVideoRepo.upsert` lo escribe sin `COALESCE`
   (`platform-video.repo.ts:144,150`) — a diferencia de `title`/`description`/
   `device_id`/`source`, que sí lo tienen. Un registro central con
   `match_status: 'sin_match'` degrada un `'manual'` local.
3. **El pull nunca desvincula.** `linked_file_id = linkedFileId ?? existing.linked_file_id`
   (`platform-video.repo.ts:150`): un `linkedFileId: null` central (puesto por
   `unlinkPlatform` o por el "desvincular el doc viejo" de
   `applyPlatformPublish:1212-1216`) nunca llega a SQLite. La corrección de un
   link mal puesto se propaga en un sentido y no en el otro.
4. **`unlinkPlatform` está roto de hecho** — ver §7.1.
5. **C5 → C2/C4 solo se dispara por `platformLinks` nuevos.** Borrar un link en
   Nube no propaga a ningún lado (`remote-library.controller.ts:569-602` solo
   itera altas).

---

## 4. Hecho 3 — Descarte (`discarded`)

Es el hecho con más formas distintas del sistema:

| Forma | Dónde | Semántica |
|---|---|---|
| `files.platforms_discarded[]` | C1, C3, L1, M1, M3 | "esta plataforma no se va a usar para este video" |
| `remote_library_videos.platformsDiscarded[]` | C5 | ídem, cola de la nube |
| `platform_states[].state === 'discarded'` | C1, C5 | procedencia del descarte |
| `files.content_status === 'descartado'` | C1, C3, L1, M1, M3 | descarte del **video entero**, no de una plataforma |
| `files.status === 'ELIMINADO_DISCO'` | C1, L1 | archivo ya no está en disco (a menudo indistinguible del anterior en las vistas) |

### Reglas por par

| Par | Regla | Código |
|---|---|---|
| L1 → C1/C3 | igual que el badge (§2.2) — el descarte viaja dentro de `platforms_discarded` | `backup.controller.ts:294-320` |
| L1 → C5 | delta: solo los descartes nuevos, y nunca sobre un `confirmed` | `mergeRemoteResolutionDelta`, `remote-library-platform-sync.service.ts:39-45` |
| M1/M3 → C1 | `$set` duro + `deriveStatesFromToggle` | `backup.controller.ts:1040-1044` |
| M1/M3 → C5 | solo los descartes nuevos, y solo si C5 no tiene la plataforma en `platforms` | `backup.controller.ts:1059-1065` |
| C5 → C1 | solo los descartes nuevos que C1 no tiene en ninguno de los dos arrays | `remote-library.controller.ts:638` |
| `content_status` L1 ↔ C1 | LWW por `local_updated_at` en el pull; en el push, **sin LWW** para C1 | `backup-sync.controller.ts:353,362` vs `backup.controller.ts:399,439` |

### Pares sin regla (descarte)

1. **"Des-descartar" no propaga en ninguna dirección.** Las tres reglas de arriba
   (`mergeRemoteResolutionDelta`, `updateFilePlatforms:1056-1058`,
   `remote-library.controller.ts:625-638`) calculan **altas** de descarte
   (`newlyDiscarded`) y nunca bajas. Sacar una plataforma de
   `platforms_discarded` queda encerrado en la representación donde se hizo.
2. **`content_status: 'descartado'` no tiene ninguna relación declarada con
   `platforms_discarded`.** Cinco consultas distintas filtran por `content_status
   != 'descartado'` (`backup.controller.ts:910`, `sync.controller.ts:1251,1411`,
   `video.controller.ts:382-383`) y otras por los arrays; nada las reconcilia. Un
   video con las 3 plataformas descartadas y `content_status: 'borrador'` es un
   estado perfectamente alcanzable y significa cosas distintas según qué vista lo
   mire (esto es el fondo de BUG-2026-09-05-02).
3. **`ELIMINADO_DISCO` se revive por nombre.** `backup.controller.ts:475-478`
   revive cualquier archivo cuyo `file_name` aparezca en un push, sin mirar
   `content_id`. Dos archivos con el mismo nombre en dos PCs distintas se
   reviven mutuamente.

---

## 5. Hecho 4 — Fecha de publicación (`publishedAt`)

Vive en **cinco** lugares, con **cuatro reglas distintas**:

| Repr. | Campo | Regla de escritura | Código |
|---|---|---|---|
| C2 | `publishedAt` | **inmutable tras el insert** (`$setOnInsert`) | `backup.controller.ts:1237` |
| C6 | `publishedAt` | **inmutable tras el insert** (`$setOnInsert`) | `backup.controller.ts:1348` |
| C4 | `published_at` | **último escritor gana** (`$set`, con `?? new Date()`) | `backup.controller.ts:872` |
| C5 | `platformLinks[].publishedAt` | reemplazo total del link de esa plataforma | `backup.controller.ts:1274` |
| C7 | `publishedAt` | mirror: pisa incondicionalmente; lectura: gana el más nuevo | `published-cards.controller.ts:173` vs `:61-63` |
| L2 | `published_at` | "el no-vacío gana" | `platform-video.repo.ts:149` |
| C9 | `lastPublishedDate` | `$set` con la fecha real del evento | `backup.controller.ts:938` |

**Por qué existe en más de un lado (razón legítima):** C6 es un log de eventos
append-only que sobrevive a cualquier wipe local, C2 es el objeto vivo del video
en la plataforma, C4 es el espejo del catálogo local. La justificación está
escrita en `upload-history.model.ts:3-9`.

**La resolución de la fecha real** está centralizada en un solo lugar
(`applyPlatformPublish`, `backup.controller.ts:1150-1158`): si el caller no manda
`publishedAt`, se le pide a la API de la plataforma; si eso falla, `new Date()`.
Toda la familia de bugs de fecha (BUG-2026-08-15-04, -06, BUG-2026-09-06-03,
BUG-2026-09-07-03) es la misma: **un caller mandó `Date()` creyendo que era un
dato y desactivó ese best-effort.** Las mitigaciones existentes son tres, en tres
lugares distintos:
- `recordUploadEvent` no defaultea (`backup.controller.ts:1320`).
- `setPlatformLink` manda `undefined` si no hay publicación previa local
  (`local video.controller.ts:342-343,363`).
- `updateRemoteLibraryVideoPlatforms` solo confía en el `publishedAt` del cliente
  si ya había un link previo (`remote-library.controller.ts:599`).

### Pares sin regla (fecha)

1. **C2 vs C6 no se reconcilian entre sí.** Los dos son inmutables tras el insert
   por separado, así que si nacen con fechas distintas quedan divergentes para
   siempre. Eso es exactamente BUG-2026-09-07-03
   (`docs/bug-reports.md:37-102`), cuyo fix de fondo quedó explícitamente sin
   implementar (`:81-89`).
2. **C4 es el único con LWW puro sobre `published_at`,** y su escritor `L2 → C4`
   no tiene protección (§3.3.1). Es decir: un push de una PC atrasada puede
   mover la fecha del espejo aunque C2 y C6 la tengan bien.
3. **C7 (`published_cards`) puede regresar.** `mirrorPublishedCards`
   (`published-cards.controller.ts:160-183`) no compara fechas antes de escribir,
   mientras que `getPublishedCards` (`:61-63`) sí las compara al leer. Un mirror
   con una fecha mala **más nueva** que la de C2 gana la lectura.

---

## 6. Hecho 5 — Métricas (views / likes / comments)

Es el hecho **mejor diseñado** del sistema y el que menos bugs produjo, y vale la
pena entender por qué.

| Repr. | Rol |
|---|---|
| C2 `views/likes/comments` | caché con TTL de las métricas reales |
| C2 `statsSyncedAt` | reloj **dedicado** de "cuándo se pidió de verdad a la API" |
| C7 `stats` | snapshot de la última métrica buena, como fallback si la API está caída |

Reglas:
- TTL adaptativo por antigüedad del video: 5 min si tiene < 2 días, 1 hora si no
  (`sync.controller.ts:611-616`).
- `statsSyncedAt` está separado a propósito de `lastSyncedAt`, con el porqué
  escrito en el modelo (`platform-video.model.ts:36-47`): `lastSyncedAt` se mueve
  con cualquier escritura del documento y por eso no servía como base de
  invalidación. `statsSyncedAt: null` en un match nuevo ⇒ siempre stale.
- Desempate entre dos documentos de la misma plataforma: gana el `platformId`
  numérico (resuelto) y, a igualdad, el `lastSyncedAt` más reciente
  (`buildFilePlatforms`, `sync.controller.ts:688-701`).
- Fallback de métrica: `live ?? previous ?? 0` (`published-cards.controller.ts:17-38`).

**La lección transferible:** este hecho tiene un timestamp propio por campo
(`statsSyncedAt`), no compartido con el resto del documento. Es la misma solución
que SYNC-01 #3 aplicó al badge (`platforms_updated_at`,
`database.ts:165-170`) — y son los dos únicos campos del sistema que la tienen.
Todos los demás pares comparan contra un `updated_at`/`local_updated_at` que se
mueve con cualquier cambio.

### Relación métricas ↔ link (pares sin regla)

1. **Las métricas viven pegadas al documento C2, no al par (archivo, plataforma).**
   Si `applyPlatformPublish` desvincula el doc viejo y crea uno nuevo
   (`backup.controller.ts:1212-1240`), el histórico de métricas queda en el doc
   huérfano. No hay migración de métricas entre documentos.
2. **`findGroupStatsCandidates` en el escritorio exige el badge Y el link**
   (`platform-video.repo.ts:289,305`) — 100% desde SQLite, sin mirar la central.
   Ese es el hallazgo #1 de BUG-2026-09-07-01 (`docs/bug-reports.md:189-196`): un
   video puede estar impecable en la central y no aparecer nunca en
   "Comparadas" de Electron. **Dirección faltante confirmada: C2 → L2 no existe
   para el caso "la central sabe de un link que la PC no tiene", salvo vía C4.**

---

## 7. Hallazgos priorizados

Ordenados por probabilidad de causar un bug real observable.

### 7.1 🔴 BUG NO REPORTADO — Desvincular un link desde Electron nunca llega a la central (falla de tipo)

`setPlatformLink` con URL vacía llama a `reportUnlinkPlatform(auth, String(fileId), platform)`
(`local-backend/src/controllers/video.controller.ts:330`), donde `fileId` es el
**id entero autoincremental de SQLite** (`files.id`, `database.ts:26`).

Eso pega a `DELETE /api/sync/platform-link/:fileId/:platform`
(`backend/src/routes/sync.routes.ts:41`) → `unlinkPlatform`
(`backend/src/controllers/sync.controller.ts:164-185`), cuya primera operación es:

```ts
const file = await FileModel.findOneAndUpdate(
  { _id: fileId, userId },   // fileId === "417"
  { $pull: { platforms: platform, platforms_discarded: platform } },
```

Un entero de SQLite no es un ObjectId de 24 hex: Mongoose tira `CastError`, el
`catch` responde 500, y del lado del cliente el error se traga con un
`console.warn` (`upload-history.service.ts:101`). El comentario en
`video.controller.ts:328-329` dice literalmente que este evento existe "para no
resucitar en el próximo pull" — **y es justo lo que nunca ocurre.**

- **Nunca se pudo haber observado que funcionara:** los IDs de las dos
  representaciones nunca fueron compatibles.
- **No verificado por ejecución** (no se corrió nada contra producción); es una
  incompatibilidad de tipos leída del código, con la ruta y el handler
  confirmados.

### 7.2 🔴 BUG NO REPORTADO — Un descarte hecho en Electron sobre una plataforma `confirmed` se revierte solo en el siguiente tick

Composición de tres reglas correctas por separado:

1. El usuario descarta Instagram desde Electron → `PATCH /api/videos/:id/platforms`
   (`local video.controller.ts:208-242`) escribe **solo SQLite** y dispara
   `pushFilesToCloudInBackground` (`:226`). Ese endpoint **no** llama a
   `POST /api/sync/file-platforms`, así que `platform_states.instagram` sigue en
   `confirmed`.
2. El push llega a `bulkUpsertBackupFiles`. Para C3 (`backup_files`) el descarte
   se aplica. Para C1 (`files`), la protección de BUG-2026-09-06-04
   (`backup.controller.ts:419-425`) lee `confirmedElsewhere` de `platform_states`
   y **vuelve a meter `instagram` en `platforms` y lo saca de
   `platforms_discarded`**.
3. El pull siguiente (`syncOrchestrator.ts:22`) lee `GET /api/backup/files`, que
   devuelve el `platforms` **de C1** (con Instagram de vuelta) pero el
   `platforms_updated_at` **de C3** (`backup.controller.ts:102-108`: se
   sobrescribe `local_updated_at` con el de C1, pero **no** `platforms_updated_at`).
   Ese timestamp es exactamente el que la PC acaba de enviar, así que
   `cloudPlatformsTs === localPlatformsTs` y la comparación
   `localPlatformsTs > cloudPlatformsTs` (`backup-sync.controller.ts:332-334`) da
   **false** ⇒ `applyPlatformsFromCloud = true` ⇒ **la SQLite recupera Instagram**.

El ciclo es determinista (no una carrera) porque el push corre antes del pull, y
se repite en cada tick. **Combinado con §7.1, no queda ningún camino funcional
para retirar una plataforma `confirmed` desde el escritorio.** El único escape
existente es dejar la plataforma en "pendiente" (fuera de los dos arrays) desde
iOS/Android, porque `deriveStatesFromToggle` sí borra el estado de una plataforma
que salió de ambos arrays (`platform-state.util.ts:65-66`) — y ese camino solo
existe en móvil.

**Causa estructural, no un descuido:** la protección del paso 2 y el desempate
del paso 3 usan datos de **procedencias distintas** (`platforms` de C1,
`platforms_updated_at` de C3). Ese es el patrón que hay que romper, no el `if`.

### 7.3 🟠 `files` (C1) no tiene LWW en el push, `backup_files` (C3) sí

`bulkUpsertBackupFiles` filtra `toUpdate` por `local_updated_at`
(`backup.controller.ts:311-320`) y lo usa para C3 (`:325`) — pero para C1
escribe sobre `incoming` completo (`:400`). Un push atrasado pisa
incondicionalmente `content_status`, `scheduled_date`, `duracion_segundos`,
`fecha_creacion` y `tipo_contenido` en la colección que **leen todos los
endpoints remotos** (`backup.controller.ts:373-376`).

Es probablemente la fuente de fondo de las divergencias que el canary de la
Entrega C está midiendo (`services/backup-canary-comparator.service.ts:93-94`
compara justamente `content_status`). No está reportado como bug.

### 7.4 🟠 `L2 → C4` sin protección: cualquier cross-match corregido puede volver a pisarse

Ya documentado como pendiente en BUG-2026-09-07-01
(`docs/bug-reports.md:230-241`), pero conviene subrayar su alcance:
`bulkUpsertBackupPlatformVideos` (`backup.controller.ts:809-835`) no compara
nada. Cualquier corrección hecha por `resolveCrossMatchSlot` o `confirmLink`
sobre C2+C4 se pierde en el siguiente push de **cualquier** PC del usuario. No
es específico del archivo que se reparó.

### 7.5 🟠 `match_status` se degrada en el pull

`platform-video.repo.ts:144,150` escribe `match_status` sin `COALESCE`, a
diferencia de los cuatro campos vecinos que sí lo tienen. Con
`cv.match_status ?? 'sin_match'` (`backup-sync.controller.ts:433`), un documento
central sin `match_status` degrada un `'manual'` local a `'sin_match'`. Eso, a su
vez, apaga el `fileRepo.addPlatform` de `:447` (que exige
`cv.match_status !== 'sin_match'`), así que el badge tampoco se recupera. No
reportado.

### 7.6 🟡 `published_cards` puede regresar (mirror sin comparación)

`mirrorPublishedCards` (`published-cards.controller.ts:160-183`) escribe sin
comparar `publishedAt`, mientras la lectura sí compara (`:61-63`). Con el
historial ya conocido de fechas contaminadas con `new Date()` (BUG-06,
BUG-2026-09-07-03), un mirror con fecha futura/errónea gana la lectura de forma
permanente hasta que C2 la supere. No reportado.

### 7.7 🟡 Dos representaciones de la cola de calendario que nunca se reconcilian

`platform_config` (C9, escrita por `syncCalendarAfterPublish`,
`backup.controller.ts:929-946`, y leída por `getCalendarConfig`,
`sync.controller.ts:1169`) y `backup_configs.platform_configs` (C10, escrita por
`pushConfigToCloud`, `backup-sync.controller.ts:165-181`, leída por
`pullConfigFromCloud`, `:457-478`) guardan la misma cola con claves distintas
(`lastVideoId` = ObjectId vs `last_video_name` = file_name) y **no se hablan
entre sí**. C10 además tiene la regla "solo rellena lo que falte, nunca pisa"
(`:462,467`), así que una vez poblada nunca converge.

Mitigación existente y muy buena: `getCalendarConfig` **no confía en el
override** y recalcula la versión dinámica desde C2, quedándose con la más
reciente (`sync.controller.ts:1159-1192`). Eso convierte C9 en una caché
opinable en vez de una fuente de verdad — es el patrón que más conviene imitar.

### 7.8 🟡 El lote de publicación es un slot único por dispositivo

iOS guarda el lote en curso en **una sola clave** de `UserDefaults`
(`PublishFormView.swift:76`), y `checkForInterruptedBatch` solo lo muestra si
`pending.fileId == source.sourceId` (`:685`). Abrir el formulario de **otro**
archivo hace que un lote interrumpido quede invisible (nunca se limpia) y el
siguiente `persistPendingBatch` (`:689-699`) lo pisa. Android tiene la misma
forma (`PendingBatchStore.kt:63`, `KEY_BATCH` único), aunque ahí el estado real
lo tiene WorkManager y el store es solo un puntero (`PendingBatchStore.kt:26-30`),
lo que lo hace mucho menos frágil.

Es la explicación más plausible de los "bugs de batches" reportados en iOS
(**no verificado contra un caso concreto del usuario** — hace falta el síntoma
exacto para confirmarlo). Su representación central (`upload_history.operationId`,
`upload-history.model.ts:28`, y `audit_events.operationId`) es solo etiqueta:
no hay ninguna consulta que reconstruya un lote a partir de ella.

### 7.9 🟡 Direcciones faltantes, resumen

| Dirección | Estado |
|---|---|
| C1 → M1/M3 (badge central → biblioteca on-device) | **no existe** |
| C2 → L2 (link central → SQLite, salvo vía C4) | **no existe** |
| "des-descartar" en cualquier par | **no existe** |
| `scheduled_date: null` C1 → L1 | **no propaga** (`backup-sync.controller.ts:364` solo aplica si `!= null`) |
| desvinculación C2 (`linkedFileId: null`) → L2 | **no propaga** (`platform-video.repo.ts:150`) |
| borrar un `platformLink` en C5 → C1/C2 | **no propaga** (`remote-library.controller.ts:569-602` solo itera altas) |
| L1 → C1 `platform_states` | **no existe** (§2.3.2) |

---

## 8. Opciones estructurales

No es un plan de implementación: es el trade-off de cada camino.

### A. Consolidar representaciones (menos pares)

El candidato obvio ya está en marcha: **eliminar C3 (`backup_files`) en favor de
C1 (`files`)** — es la Entrega D del plan de consolidación
(`docs/mongo-collections-consolidation-plan-2026-09-02.md`, con el flag
`BACKUP_CANONICAL_READS` ya implementado en `backup.controller.ts:38`).

- **Se gana:** desaparece la asimetría de §7.3 y, crucialmente, **desaparece el
  mecanismo de §7.2** (el timestamp y el valor volverían a tener la misma
  procedencia). Bajan de ~11 a ~10 representaciones, pero de N pares a N-k, que
  es lo que importa.
- **Se paga:** hay que cerrar antes la comparación canary sin diferencias, y hoy
  el canary compara justamente los campos que §7.3 hace divergir — es decir, el
  bug de §7.3 probablemente esté **bloqueando su propia solución**. Conviene
  arreglar §7.3 primero, dejar que el canary converja, y recién ahí retirar C3.
- El segundo candidato es **C4 vs C2**: C4 existe únicamente porque el pull del
  escritorio lee de ahí (`backup-sync.controller.ts:412`). Si el pull leyera C2
  directamente, se elimina el par sin regla de §7.4 de raíz. Cuesta más: C2 usa
  `linkedFileId` (ObjectId) y el pull necesita `file_name`/`content_id`, que es
  precisamente el motivo por el que C4 se creó (`backup-platform-video.model.ts:15-16`).

### B. Formalizar las reglas en un solo lugar

`platform-state.util.ts` ya demuestra que funciona: define un tipo, tres
transiciones y una regla dura ("`confirmed` nunca se degrada"), y los cuatro
callers lo importan (`file.model.ts:2`, `remote-library-video.model.ts:2`,
`backup.controller.ts:17`, `remote-library.controller.ts`). Los bugs de badge que
quedan **no están en esas reglas** sino en los caminos que no las usan.

- **Se gana:** una tabla explícita "campo × par → regla" hace visible el hueco
  antes de que sea un bug. Además obliga a nombrar el problema real de §7.2: hoy
  ninguna regla declara de qué representación sale el timestamp con que se
  compara.
- **Se paga:** es refactor sin feature visible, y la parte difícil no es
  escribir el módulo sino **redirigir los callers** (p. ej. hacer que
  `PATCH /api/videos/:id/platforms` del escritorio pase por el mismo camino que
  `POST /api/sync/file-platforms`, que es lo que cerraría §7.2 de forma limpia).
- **Extensión barata y de alto rendimiento:** generalizar el patrón
  `platforms_updated_at`/`statsSyncedAt` — un reloj por **hecho**, no por
  documento. Son los dos únicos campos que lo tienen y son los dos hechos con
  menos bugs de reconciliación. Es la única intervención de este documento que
  se paga sola.

### C. Intermedio (recomendado): "recalcular en vez de confiar"

`getCalendarConfig` (`sync.controller.ts:1159-1192`) ya hace esto: en vez de
reconciliar C9 con C2, **degrada C9 a una caché opinable** y recalcula la verdad
desde C2 en cada lectura, quedándose con lo más reciente. Lo mismo hace
`getPublishedCards` (`published-cards.controller.ts:58-86`).

- **Se gana:** un par sin regla deja de importar, porque la lectura no depende de
  que las dos copias estén de acuerdo. No requiere migración de datos ni tocar
  los escritores. Es aplicable hoy a C7 (§7.6) y a la elegibilidad de cross-match.
- **Se paga:** costo por request (`computeLastPublishedDynamic` hace un `find`
  por plataforma en cada lectura del calendario), y solo sirve donde hay una
  representación defendible como "la más autoritativa". Para el badge no la hay:
  C1 y L1 son ambos legítimamente autoritativos según quién tocó el video último.

### El orden push-antes-que-pull: ¿aislable?

`syncOrchestrator.ts:21-23` corre `push()` → `pull()` → `ensurePreload()`.
Invertirlo es literalmente intercambiar dos líneas, **pero no es aislable**:

- **A favor:** hoy el orden garantiza que el cliente pisa la nube con su copia
  vieja y después lee de vuelta lo que él mismo pisó (mecanismo textual de
  BUG-2026-09-07-01, `docs/bug-reports.md:205-211`, y el paso 3 de §7.2). Con
  pull primero, ese ciclo se rompe: el cliente se entera de lo nuevo antes de
  empujar.
- **En contra (lo que arrastra):** varias reglas del pull están escritas
  **asumiendo** que el push ya corrió. La más clara es §7.2 paso 3: el
  `platforms_updated_at` que devuelve la nube es el que la PC acaba de mandar;
  invirtiendo el orden, ese timestamp pasa a ser el de *antes* del cambio local,
  y el resultado cambia — para bien en ese caso, pero **hay que revisar los tres
  criterios del pull** (`applyPlatformsFromCloud`, `otherFieldsFromCloud`, la
  rama `localEmpty && cloudHas` de `backup-sync.controller.ts:355-377`), porque
  ninguno fue escrito contra el orden inverso.
- El segundo arrastre es `ensurePreload`: depende de que el `nextVideoId`
  central ya refleje el push (`backup-sync.controller.ts:543-548`). Con pull
  primero, la precarga usaría el estado anterior y se retrasaría un tick — no
  rompe nada, pero cambia el comportamiento observable.
- **Y el ciclo no desaparece del todo.** El push tras publicar
  (`pushFilesToCloudInBackground`, `backup-sync.controller.ts:185-199`) se
  dispara fuera del orquestador, desde 6+ callers. Invertir el tick reduce
  drásticamente la frecuencia del ciclo, pero **no lo elimina**: mientras
  `L2 → C4` (§7.4) y `L1 → C1` (§7.3) no tengan una regla de precedencia, el
  push inmediato sigue pudiendo pisar una corrección central hecha en el
  intervalo.

**Conclusión:** invertir el orden es una mitigación barata y de bajo riesgo, pero
no es un fix. Los fixes son las reglas de precedencia de §7.3 y §7.4, y la unión
de procedencia valor/timestamp de §7.2.

---

## Apéndice — Los 6 bugs originales, mapeados a este documento

| Bug | Par que falló | Sección |
|---|---|---|
| BUG-2026-09-06-02 | C5 → C1/C2 (link real tras un badge previo) | §3.2, §3.3.5 |
| BUG-2026-09-06-04 | L1 → C1 (push pisando `confirmed`) | §2.2, §7.2 |
| BUG-2026-09-05-01 | C1 → C5 (descartes que no propagaban) | §4 |
| BUG-2026-09-07-01 | L2 → C4 → C2 (push sin LWW + push-antes-que-pull) | §3.3.1, §7.4 |
| BUG-2026-09-07-02 | dentro de C1: `facebook` mezclado con las 3 comparables | §1 (vocabulario), §2 |
| BUG-2026-09-07-03 | C2 ↔ C6 (`publishedAt` con dos `$setOnInsert` independientes) | §5 |
