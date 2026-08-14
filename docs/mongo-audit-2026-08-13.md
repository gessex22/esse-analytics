# Auditoría de MongoDB — 2026-08-13

Auditoría de solo lectura sobre los esquemas, controladores, índices y datos
reales de la central. No se modificaron documentos ni índices.

## Estado de remediación (actualizado 2026-08-13)

| Fix | Estado | Detalle |
| --- | --- | --- |
| P0 — índice legado `platformvideos.platform_1_platformId_1` | ✅ Aplicado | Eliminado en producción (Atlas). Preflight: 0 combinaciones `platform+platformId` compartidas entre distintos `userId`. |
| P0 — índice único `platform_config.{userId,platform}` | ✅ Aplicado | Creado como `userId_1_platform_1` en producción. Preflight: 0 duplicados por `(userId, platform)`. |
| P1 — `platformLinks` ausente en 1,092 videos remotos | Reclasificado a backlog, no bug activo | Confirmado en código (`remote-library.controller.ts`): `platformLinks` solo se llena vía `updateRemoteLibraryVideoPlatforms`, sin backfill automático. Son registros históricos nunca matcheados a mano, no una regresión. No bloquea nada — el fallback ante array vacío ya está cubierto. |
| P1 — `publishing_status` como 4ta fuente de "publicado" | ✅ Deprecado (pasos 1-3) | Sacados `getPublishingStatus`/`updatePublishingStatus` y el tipo `PublishingStatus` de `frontend/src/services/api.ts` (sin callers). Rutas/controllers/modelo marcados LEGACY en central y local-backend (comentarios, sin borrar). De paso se eliminó `local-backend/src/models/publishing-status.model.ts`, un modelo mongoose huérfano (nunca importado, local-backend ni siquiera tiene `mongoose` de dependencia) que rompía `tsc --noEmit`. Falta el paso 4 (borrar ruta/modelo/colección) — no urgente, esperar un tiempo prudencial. |
| P1 — identidad de `files`/`backup_files`/`file_path` | Sin aplicar | Requiere migración de índice más cuidadosa (índice único parcial excluyendo `content_id: null`, ver `docs/mongo-remediation-review-plan.md`). |
| P2 — normalización de arrays nulos / archivo con >3 resoluciones | Sin aplicar | — |

**Script usado para los fixes P0:** `backend/scripts/mongo-p0-index-fixes.js`
(dry-run por default, `--apply` para escribir; imprime preflight, postflight y
los comandos exactos de rollback). Corrido en producción el 2026-08-13:

```
Eliminado: platformvideos.platform_1_platformId_1
  Rollback: db.platformvideos.createIndex({platform:1,platformId:1},{unique:true,name:"platform_1_platformId_1"})
Creado: platform_config.userId_1_platform_1
  Rollback: db.platform_config.dropIndex("userId_1_platform_1")
```

Antes de cualquier otro fix de este documento (identidad de archivos,
consolidación de `publishing_status`, backfill de `platformLinks`), seguir el
protocolo de `docs/mongo-remediation-review-plan.md`.

## Resumen

La base tiene 16 colecciones activas. El modelo ya separa correctamente cuenta,
catálogo, eventos, sincronización y almacenamiento remoto, pero aún conserva
fuentes de verdad duplicadas e índices heredados de cuando la app era de un
solo usuario. Esos dos temas explican buena parte de los fixes defensivos que
hay hoy en los clientes y en `backup.controller.ts`.

| Prioridad | Hallazgo | Riesgo |
| --- | --- | --- |
| P0 | Índice global único en `platformvideos` por `platform + platformId` | Bloquea que dos usuarios tengan el mismo video/ID de plataforma. |
| P0 | `platform_config` no tiene índice único por `userId + platform` | Dos escrituras concurrentes pueden producir configuraciones duplicadas. |
| P1 | `files` usa `file_path` único global, pero los backups crean paths placeholder con el nombre | Colisión entre cuentas con el mismo nombre de archivo. |
| P1 | `publishing_status`, `files`, `platformvideos` y mirrors guardan el mismo estado | Ya hay 27 estados de publicación que no coinciden. |
| P1 | 1,092 videos remotos marcados publicados no tienen `platformLinks` | Se pierde el ID/URL exacto de la publicación. |
| P2 | Campos legacy nulos y mirrors parciales | Aumentan la complejidad de cada pull y de los fallbacks. |

## Mapa de colecciones

| Colección | Rol | Escritura principal | Lectura principal |
| --- | --- | --- | --- |
| `users` | Cuenta, rol, plan y cuentas vinculadas | Auth, OAuth, administración | Auth, settings, gates de plan |
| `oauth_tokens` | Tokens OAuth por proveedor | Controladores YouTube/Instagram/TikTok | Uploaders y sync de proveedores |
| `files` | Catálogo central por usuario; estado de archivo y plataformas | Backup bulk, publicación y sincronización | Videos, calendario, sync y pull |
| `backup_files` | Espejo portable del catálogo local | `POST /api/backup/files/bulk` | Pull de Electron/Android |
| `platformvideos` | Video real de plataforma, métricas y matching | Sync, uploaders, `applyPlatformPublish` | Estadísticas, matching y calendario dinámico |
| `backup_platform_videos` | Espejo portable de IDs/URLs de plataforma | Backup bulk y `applyPlatformPublish` | Pull de Electron |
| `upload_history` | Estado/evento más reciente por publicación | `recordUploadEvent` | Historial y último video del dashboard |
| `platform_config` | Cadencia y punteros de calendario por plataforma | Publicación, calendario y skip | Calendario y próximas publicaciones |
| `backup_configs` | Preferencias/calendario del SQLite local | Backup config | Recuperación de instalación |
| `remote_library_videos` | Bytes y metadata de Biblioteca remota | TUS/remoto, publish y retention | Biblioteca móvil/remota |
| `transcripts` | Transcripciones legacy ligadas a `files._id` | Flujo legacy | Ideas y detalle de video |
| `transcript_backups` | Espejo portable de transcripciones locales | Backup transcripts | Pull tras wipe |
| `ideas_centrales` | Ideas y sus videos vinculados | Ideas | Taller/ideas y pull |
| `publishing_status` | Flags legacy por archivo y plataforma | Ruta `publishing-status` | UI legacy de estado |
| `published_cards` | Última tarjeta por plataforma para remoto | Mirror de desktop | Vista remota legacy |
| `audit_events` / `loginlogs` | Auditoría persistente / seguridad con TTL de 90 días | Servicios de audit/auth | Soporte y auditoría |

## Resultados de integridad sobre los datos actuales

| Comprobación | Resultado | Lectura |
| --- | ---: | --- |
| Documentos sin `userId` en colecciones de negocio | 0 | El backfill multiusuario está aplicado a los datos actuales. |
| Duplicados por `(userId, content_id)` en `files` | 0 | No hay duplicados hoy; falta blindarlo con índice único. |
| Duplicados por `(userId, content_id)` en `backup_files` | 0 | Igual: datos sanos, protección insuficiente. |
| Duplicados por `(userId, platform)` en `platform_config` | 0 | Sin duplicados actuales, pero tampoco índice que los impida. |
| `files.platforms` y `platforms_discarded` se superponen | 0 | Estado lógico consistente en este punto. |
| Archivos con más de tres resoluciones de plataforma | 1 | Dato corrupto o legado que debe aislarse y reparar. |
| `transcripts`, `publishing_status` o `platformvideos` huérfanos | 0 | Las referencias existentes siguen vivas. |
| Historial sin `PlatformVideo` correspondiente | 3 | El fallback de recuperación cubre esto, pero no debería ser normal. |
| Historial sin `BackupPlatformVideo` correspondiente | 1 | Puede perder el enlace exacto al hacer pull en Electron. |
| `publishing_status` distinto de `files.platforms` | 27 | Duplicación de estado ya materializada en datos reales. |
| `files` sin fila correspondiente en `backup_files` | 37 | El endpoint los mezcla deliberadamente; indica que el mirror no es completo. |
| `remote_library_videos` publicados sin `platformLinks` | 1,092 | La plataforma se marca como resuelta sin guardar el enlace/ID exacto. |
| `files.platforms` nulo o no-array | 6 | Legacy/schema drift. |
| `files.platforms_discarded` nulo o no-array | 13 | Legacy/schema drift. |
| `remote_library_videos.platformLinks` nulo o ausente | 1,094 | La mayoría son documentos previos al campo; el código debe seguir usando fallback seguro. |

## Huecos y contradicciones

### P0 — Índices incompatibles con multiusuario

`platformvideos` posee a la vez el índice actual único
`{ userId, platform, platformId }` y el legado único
`{ platform, platformId }`. El segundo hace que dos cuentas no puedan guardar
el mismo ID nativo, aunque el esquema y los controladores ya filtran por
`userId`.

Acción recomendada: verificar que no haya duplicados por plataforma/ID entre
usuarios y eliminar el índice legado `platform_1_platformId_1` mediante una
migración explícita y reversible.

`platform_config` se consulta y actualiza como si fuera una fila por cuenta y
plataforma, pero no tiene índice. Debe tener:

```js
db.platform_config.createIndex({ userId: 1, platform: 1 }, { unique: true })
```

antes de depender de más automatismos de calendario.

### P1 — Identidad de archivo no está consolidada

`content_id` se describe como identidad estable y ya se usa para resolver
renombres, pero los índices de `files` y `backup_files` no son únicos. Los
datos actuales no presentan duplicados, así que es una buena oportunidad para
crear índices únicos parciales por `(userId, content_id)` después de validar
clientes legacy.

Además, `files.file_path` es único global. En el flujo de backup se crean filas
centrales con `file_path = file_name` como placeholder. Dos usuarios con
`render.mp4` pueden colisionar; el índice debe pasar a ser compuesto por
`userId + file_path`, o el central debe dejar de usar ese placeholder como
identidad.

### P1 — Cuatro representaciones de “publicado”

El mismo hecho se expresa en:

1. `files.platforms` / `platforms_discarded` — badge y elegibilidad.
2. `platformvideos` — ID/URL/métricas y matching.
3. `backup_platform_videos` — recuperación de Electron.
4. `publishing_status` — flags legacy.

`applyPlatformPublish()` es un buen punto de consolidación para las tres
primeras, pero `publishing_status` queda aparte. Los 27 desacuerdos medidos
confirman que no puede seguir tratándose como fuente fiable. La recomendación
es declararlo legacy de solo lectura, migrar sus consumidores a
`files.platforms`, y después eliminar ruta/modelo con una migración.

### P1 — Biblioteca remota sin links precisos

Un video remoto puede tener `platforms: ["tiktok"]` y no tener ninguna entrada
en `platformLinks`. Eso impide reconstruir URL/ID exactos y fuerza fallbacks
por nombre. Hay 1,092 casos actuales. Nuevas publicaciones deben escribir ambos
campos en una única operación; para los históricos, se puede backfillear desde
`platformvideos`/`backup_platform_videos` por `contentId` y, solo como fallback,
por nombre inequívoco.

### P2 — Historial no es realmente append-only

El comentario de `upload_history` lo describe como log append-only, pero su
índice único `(userId, platform, platformId)` y `updateOne(..., upsert: true)`
hacen que una republicación actualice el documento anterior. `audit_events` sí
es el log append-only. La documentación y los nombres deben aclarar que
`upload_history` representa el estado/último evento por publicación, no un
historial inmutable.

### P2 — Mirrors parciales y campos legacy

Los 37 `files` sin `backup_files`, los tres eventos de historial sin
`PlatformVideo` y el evento sin `BackupPlatformVideo` no rompen hoy porque los
endpoints tienen merge y reparación bajo demanda. Sí convierten cada lectura en
una reconciliación costosa y dejan más espacio para carreras.

Los campos array nulos en `files` y `platformLinks` ausente en documentos
remotos deben normalizarse con una migración de datos. Hasta entonces, todas las
consultas/aggregations deben usar `$ifNull` y los clientes deben asumir arrays
vacíos.

## Secuencia propuesta de corrección

1. Agregar un script de diagnóstico repetible (solo lectura) con estas métricas
   y ejecutarlo antes/después de cada migración.
2. Corregir los índices P0: eliminar el índice global de `platformvideos` y
   crear el único de `platform_config`.
3. Normalizar arrays nulos y reparar el archivo con más de tres resoluciones.
4. Hacer únicos los `content_id` por usuario y reemplazar el índice global de
   `files.file_path`.
5. Consolidar escritura de publicación en `applyPlatformPublish`, backfillear
   `platformLinks` y retirar `publishing_status` de los consumidores.
6. Documentar la semántica definitiva: `audit_events` es inmutable;
   `upload_history` es una proyección idempotente; los mirrors son
   recuperables, nunca fuentes de verdad.
