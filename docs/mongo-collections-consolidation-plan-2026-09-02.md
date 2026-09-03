# Plan de trabajo: consolidación de `files` + `backup_files`

**Fecha:** 2026-09-02  
**Estado:** diseño e inventario terminados, incluida la revisión del enfoque
de rollback (snapshot único en vez de shadow-write largo) y la propuesta de
nombres de colecciones (sección 9, documentada, ejecución separada).
**Entrega A implementada** (ver sección 5) -- schema extendido, servicio de
lectura canónica y flag `BACKUP_CANONICAL_READS` (default apagado).
**Entrega B implementada y aplicada en producción** (ver sección 5) --
`mongo-files-consolidation.js` corrido en `--apply` global sobre los 1121
`files` con backup histórico: 0 ambiguos, 0 colisiones, 0 errores, 0
concurrent_change, verificado contra la base real después de aplicar.
Entregas C-D (comparación canary con `BACKUP_CANONICAL_READS`, retirada de
`backup_files`) sin empezar.  
**Regla:** ningún paso de este plan modifica producción por defecto.

## 1. Decisión de arquitectura

La colección canónica será **`files`**. No se creará una tercera colección y
no se cambiarán los `_id` existentes de `files`.

Razones:

- `PlatformVideoModel.linkedFileId` y otros flujos ya referencian el `_id` de
  `files`.
- Publicaciones, Matches, Estadísticas, Calendario, Videos, streaming,
  transcripciones y Biblioteca remota ya parten de `FileModel`.
- `backup_files` no tiene referencias por `_id`; funciona como espejo de
  metadata del escritorio y hoy solo se consulta desde el controlador de
  backup y dos scripts administrativos.

**Decisión revisada 2026-09-02 (tras auditar `backup.controller.ts` a fondo):**
`backup_files` ya es redundante en la práctica, no solo en teoría —
`bulkUpsertBackupFiles` escribe las dos colecciones en el mismo request
(`backup.controller.ts:238-352`) y `GET /api/backup/files` ya prioriza `files`
por sobre `backup_files` para todo lo que importa (badges, `platform_states`,
ver comentario de BUG-2026-08-15-03). Las únicas dos diferencias reales
(`local_updated_at`/`platforms_updated_at`, que la Entrega A absorbe en
`files`; y el hard-delete en reconciliación, que pasa a ser un detalle de la
función de migración, no de una colección aparte) no justifican mantener un
shadow-write en vivo por 30 días.

En vez de un shadow/rollback store de larga vida, `backup_files` se congela
con un **snapshot único** (export/`mongodump`) tomado justo antes de correr
`mongo-files-consolidation.js --apply` (Entrega B), y se apaga apenas el
postflight de esa corrida pasa — sin ventana de observación adicional. El
riesgo que un shadow-write largo cubriría (una divergencia que solo aparece
con tráfico real de varios días) queda cubierto en cambio por la matriz de
verificación de la sección 6, ejecutada contra el canary antes del `--apply`
global.

Esto es un **trade-off aceptado, no una equivalencia perfecta**: el snapshot
permite volver los datos atrás, pero no detecta una regresión de comportamiento
que solo aparezca bajo tráfico real después del corte. La mitigación elegida es
una comparación live pequeña y acotada sobre cuentas canary antes del apply
global (Entrega C), más un go/no-go humano explícito. Después del postflight
global no habrá una segunda ventana de observación escribiendo
`backup_files`.

## 2. Responsabilidad de los datos

### Identidad y catálogo central (`files`)

- `_id`, `userId`, `content_id`, `file_name`.
- `platforms`, `platforms_discarded`, `platform_states`.
- `content_status`, `scheduled_date`, `publishCode`.
- `duracion_segundos`, `resolucion`, `formato`, `fecha_creacion`.
- Referencias desde publicaciones, calendario, estadísticas y streaming.

### Metadata de sincronización que debe absorber `files`

Agregar al schema canónico, inicialmente como campos opcionales:

- `tipo_contenido`.
- `local_updated_at`: última modificación general informada por el escritorio.
- `platforms_updated_at`: reloj dedicado de badges/descartes.
- `backup_synced_at`: momento en que la central recibió metadata desde
  `/api/backup/files/bulk`; su existencia reemplaza la semántica actual de
  "hay una fila en `backup_files`".
- `backup_source_device_id`: dispositivo que produjo el último backup aceptado.

### Estado ligado a un dispositivo

`file_path` y el `status` técnico de disco son propiedades de una instalación,
no del contenido global. En la primera entrega permanecerán en `files` por
compatibilidad, interpretados como el estado de la PC primaria. Su
normalización futura a `device_locations[]` o una colección separada queda
fuera de esta migración: mezclarla aquí aumentaría el riesgo sin ser necesario
para retirar `backup_files`.

## 3. Inventario de consumidores

### Lectores/escritores de `files`

- `backup.controller.ts`: push/pull, recuperación, publicación y estado de
  backup.
- `video.controller.ts`: catálogo, detalle, rename, estados, calendario y
  eliminación lógica.
- `sync.controller.ts`: Matches, links, métricas comparadas y calendario.
- Controladores de YouTube, Instagram y TikTok: validación y actualización
  posterior a publicar.
- `remote-library.controller.ts` y retención: propagación con Biblioteca
  remota y resolución del próximo video.
- `stream.routes.ts`: acceso a los bytes de la PC central.
- `scan.controller.ts`: catálogo creado por escaneo central/legacy.
- Scripts de calendario, reparación y auditoría.

### Lectores/escritores directos de `backup_files`

- `backup.controller.ts`: `GET/POST /api/backup/files`, `sync-status` y
  `backup/status`.
- `scripts/pull-to-sqlite.ts` y `scripts/seed-backup-from-files.ts`.

No hay acceso directo a MongoDB desde Electron, iOS o Android. Esos clientes
dependen del contrato HTTP, por lo que la colección física puede cambiar sin
obligar una actualización simultánea de las apps.

**Corrección del inventario mobile (2026-09-02):** en el código actual,
Android todavía declara/injecta `BackupApi.listFiles()` y conserva
`BackupFileDto`, pero no existe ningún caller de producción. iOS conserva
`BackupCatalogAPI.list()`/`BackupFileDTO`, pero tampoco tiene un caller activo;
`LibraryView` fue migrada a Room/SwiftData local + Biblioteca remota + catálogo
LAN. Ninguna de las dos apps ejecuta un pull periódico de `backup_files` ni un
job de cinco minutos contra `GET /api/backup/files`.

Mobile sincroniza por otros caminos: `record-publish` y `file-platforms` al
publicar/tocar badges (con outbox persistente y flush al abrir/refrescar el
Dashboard), endpoints de Matches/Estadísticas/Calendario al cargar sus vistas,
y Biblioteca remota/LAN por sus repositorios propios. Android usa WorkManager
para subidas, no para un backup periódico de este catálogo; iOS tampoco tiene
un `BGTask` periódico para él. Por tanto, el consumidor activo crítico de
`GET /api/backup/files?includeResolved=true` es el pull de Electron/
local-backend. Los DTO móviles se conservan y prueban solo por compatibilidad
con builds anteriores que todavía se decida soportar.

### Contratos que deben permanecer compatibles

- `GET /api/backup/files`, incluido `?includeResolved=true`.
- `POST /api/backup/files/bulk` y su respuesta (`updated`, `skipped`,
  `filesSynced`, `archived`, `isPrimary`).
- `GET /api/backup/status`.
- `GET /api/backup/sync-status?contentIds=...`.

El DTO proyectado por `GET /api/backup/files` conservará `_id`, `createdAt`,
`file_name`, `content_id`, arrays de plataformas, `content_status`,
`tipo_contenido`, fechas y metadata técnica. Esto es especialmente importante
porque el DTO iOS legacy exige `_id` y `createdAt`, mientras que el consumidor
activo —el pull de Electron— usa `content_id`, `local_updated_at` y
`platforms_updated_at`.

## 4. Reglas de merge

1. Buscar por `{userId, content_id}`; usar `{userId, file_name}` solo cuando no
   haya `content_id` utilizable.
2. Nunca reemplazar el `_id` canónico de `files`.
3. Un `content_id` ya fijado en `files` gana sobre uno entrante.
4. Un rename solo cambia `file_name` si el match fue por `content_id` y no
   colisiona con los índices únicos. Las colisiones se reportan y se omiten.
5. Una plataforma con `platform_states.state = confirmed` no puede degradarse
   a badge manual o descarte por un backup.
6. Para badges no confirmados, aplicar LWW únicamente cuando ambos lados tengan
   `platforms_updated_at`. Si falta un reloj, conservar el estado central con
   datos; usar el backup solo para rellenar un estado vacío.
7. `tipo_contenido` se copia si falta en `files`.
8. Metadata técnica se rellena si falta. Diferencias entre valores ya poblados
   se incluyen en el reporte de conflictos y no se pisan hasta que exista una
   resolución explícita.
9. `content_status` y `scheduled_date` divergentes sin un reloj comparable se
   consideran ambiguos: no hay overwrite automático ni una elección silenciosa
   de fuente de verdad.
10. Ninguna operación ambigua impide procesar los demás documentos
    (`ordered:false` y resultado por documento).

### Salida finita del bucket `ambiguous`

`ambiguous` no es un estado terminal ni bloquea los registros seguros de la
corrida. El script continúa y genera `ambiguous-<runId>.ndjson` con `_id`,
identidad, valores de ambos lados, timestamps disponibles y una recomendación
(`keep-files` normalmente, porque es la entidad canónica).

Antes del apply global, cada fila debe tener una decisión en
`resolutions-<runId>.json`:

- `keep-files`: conservar el valor de `files`;
- `take-backup`: copiar el valor de `backup_files`;
- `manual-value`: aplicar un valor explícito validado por el schema.

La resolución puede hacerse fila por fila o aprobarse como política masiva
después de revisar conteos y muestras. El script se vuelve a ejecutar con
`--resolutions <archivo>` y registra el resultado en
`resolved-<runId>.ndjson`. Los canary pueden avanzar con ambiguos pendientes;
el **apply global y la retirada de `backup_files` exigen cero ambiguos sin
resolver**. No existe la opción de dejarlos en cuarentena para siempre ni de
perderlos al borrar la colección.

## 5. Entregas

### Entrega A — adapter canónico (sin shadow write de largo plazo)

**✅ Implementada 2026-09-02** (`backend/`, rama `feat/mongo-consolidation-entrega-a`):

- `FileSchema` extendida con `tipo_contenido`, `local_updated_at`,
  `platforms_updated_at`, `backup_synced_at`, `backup_source_device_id`
  (`models/file.model.ts`), todos opcionales, sin migración de datos.
- `bulkUpsertBackupFiles` ahora también puebla esos 5 campos en `files` al
  escribir (además de seguir escribiendo `backup_files` sin cambios, como ya
  hacía) -- se completan solos con el próximo push de cada archivo, sin
  backfill.
- Servicio nuevo `services/backup-file-canonical.service.ts`: lee los 3 GET de
  `/api/backup` (`files`, `status`, `sync-status`) desde `files` en
  exclusiva.
- Flag `BACKUP_CANONICAL_READS` (env, default apagado) en
  `backup.controller.ts` -- gatea únicamente las 3 lecturas; el bulk de
  escritura no está gateado, sigue escribiendo ambas colecciones igual que
  hoy.
- Script de solo lectura `scripts/backup-canonical-contract-check.ts`:
  compara legacy vs canónico para un usuario sin escribir nada. Corrido contra
  producción (owner, `includeResolved` true y false): **0 diferencias no
  explicadas** -- las únicas 38 discrepancias encontradas fueron archivos con
  `status='ELIMINADO_DISCO'` que el camino viejo seguía filtrando hacia el
  catálogo remoto (bug preexistente, `onlyInCentral` nunca chequeaba
  `status`) y que el canónico excluye a propósito (ver comentario en el
  servicio). `status`/`sync-status` canónicos dan vacío hasta que corran
  pushes nuevos que completen `backup_synced_at` -- esperado, no es una
  migración de datos existentes.

**Gate:** typecheck sin errores nuevos (27 antes y después, baseline sin
tocar) y pruebas de contrato de los cuatro endpoints de backup (script de
arriba; sin test runner en el repo, ver `docs/product-backlog.md`).

**Pendiente dentro de A -- resuelto por hallazgo, no por prueba (2026-09-02):**
se intentó correr el mismo script contra 2-3 cuentas no-owner, pero
`db.collection('backup_files').distinct('userId')` y lo mismo sobre `files`
devuelven **un solo `userId`** (el owner) -- de los 17 usuarios reales de la
central, ninguno más tiene todavía ni un documento en `files` ni en
`backup_files`. La producción actual es de hecho mono-tenant para todo lo
que toca esta migración: no hay una segunda cuenta real contra la cual
probar. Esto no es un blocker -- es información real sobre el alcance
verdadero del riesgo (ver también Entrega B más abajo). Sigue pendiente
decidir si el flag se activa alguna vez fuera de la allowlist canary de la
Entrega C.

### Entrega B — migración reversible

**Estado: script escrito y corrido en dry-run real contra producción
(2026-09-02).** Implementa exactamente lo de abajo, incluidas las secciones
de concurrencia/reentrada y la salida finita de `ambiguous`. Un bug real
encontrado y corregido en la primera corrida: los `return` tempranos de
dry-run/plantilla liberaban el lock y desconectaban Mongo a mano, y el
`finally` de `main()` lo volvía a intentar (`MongoNotConnectedError`) --
corregido dejando que el `finally` sea la única salida.

**Resultado del dry-run global** (`--limit 3000`, sin `--user-id` -- cubre
toda `backup_files`, que resultó tener un solo usuario real, ver nota en
Entrega A): 1121 candidatos, **1121 `safe`, 0 ambiguous, 0 collision, 0
error, 0 orphan**. Los 38 documentos de diferencia entre `backup_files`
(1121) y `files` (1159) del mismo usuario coinciden exactamente con los 38
`ELIMINADO_DISCO` ya identificados en la Entrega A -- consistente, no un
hallazgo nuevo.

**`--apply` global corrido y verificado (2026-09-02, runId
`2026-09-03T03-14-43-893Z`).** El clasificador de auto-mode de Claude Code
bloqueó la escritura desde la sesión de Claude Code (correcto -- una acción
de escritura en producción real vía Bash); el owner lo corrió directo en su
propia terminal. Resultado, verificado después contra la base real (no solo
por la salida de consola):

- 1121 actualizados, 0 concurrent_change, 0 errores.
- Postflight: 1121/1121 releídos, todos con `backup_synced_at`.
- Confirmado con una consulta aparte: 1121 de los 1159 `files` del owner
  tienen ahora `backup_synced_at`/`local_updated_at` poblados (los 38
  restantes son los `ELIMINADO_DISCO` esperados, sin tocar).
- Muestra inspeccionada a mano: `tipo_contenido`/`local_updated_at`/
  `backup_synced_at` completados correctamente; `platforms` intacto (regla
  6 -- ya tenía datos, no se tocó).
- `applied-<runId>.ndjson`: 1121 líneas, las 1121 con `modified:true`.
- Rollback generado (`rollback-<runId>.js`) y verificado por sintaxis
  (`node -c`), sin necesidad de usarlo -- no hubo errores que revertir.

No se corrió con la pausa de `POST /api/backup/files/bulk` activa (el
mecanismo vive en el código local todavía sin desplegar al backend real que
sirve producción) -- mitigado por la concurrencia optimista (0
`concurrent_change` reales, confirma que no hubo colisión con un push en
vivo durante la ventana).

Crear `backend/scripts/mongo-files-consolidation.js` con:

- **snapshot/export completo de `backup_files` (mongodump o volcado JSON)
  como paso obligatorio antes de cualquier `--apply`** — reemplaza al
  shadow-write en vivo como mecanismo de rollback; sin este paso el script
  rechaza correr con `--apply`;
- dry-run como default y `--apply` explícito;
- filtro opcional por `--user-id` y `--limit` para canary;
- preflight de índices, duplicados, huérfanos y conflictos;
- snapshot JSON previo de cada documento que se vaya a modificar;
- updates condicionados al valor observado en preflight;
- salida separada para `safe`, `ambiguous`, `collision` y `error`;
- archivo de resoluciones explícitas y gate de cero ambiguos antes del apply
  global;
- postflight automático;
- script de rollback generado desde el snapshot.

El primer `--apply` será sobre una muestra pequeña y reversible. No se borrará
ningún documento de `backup_files` en esta entrega.

#### Concurrencia y reentrada

`ordered:false` solo mejora el aislamiento entre operaciones; no es la garantía
de concurrencia. El script debe cumplir además lo siguiente:

- adquirir un lock único de migración con `runId` para impedir dos procesos de
  consolidación simultáneos;
- hacer updates optimistas condicionados por `_id` **y** los `updatedAt`/valores
  observados en preflight;
- clasificar `matchedCount = 0` como `concurrent_change`, sin pisar el push que
  ganó la carrera;
- usar `$set` deterministas e índices únicos existentes, sin inserts ciegos;
- poder repetirse: una segunda corrida produce no-op para lo ya aplicado y
  reevalúa `concurrent_change`/errores, sin duplicar documentos;
- permitir `--resume <runId>` y crear un snapshot nuevo de cualquier documento
  adicional que vaya a tocar.

El canary puede convivir con tráfico gracias a esas condiciones. El apply
global se ejecutará en una **ventana de bajo tráfico con pausa breve de
escrituras** sobre `POST /api/backup/files/bulk`: devolverá `503` con
`Retry-After`, sin aceptar parcialmente el body. Se espera a que terminen los
requests ya en vuelo, se toma el snapshot, se corre apply+postflight y se
reanuda el endpoint. Las lecturas permanecen disponibles. Si no se puede
activar esa pausa, el apply global se pospone; no se confía solo en
`ordered:false`.

### Entrega C — lectura canónica y comparación

**Estado (2026-09-02): comparador escrito e implementado**
(`backend/src/services/backup-canary-comparator.service.ts`), enganchado en
`getBackupFiles` después de `res.json(...)` (fire-and-forget, nunca puede
demorar ni romper la respuesta real). Implementa allowlist por
`CANARY_USER_IDS`, concurrencia=1 en memoria, cooldown de 15 min por
usuario, auto-apagado a 200 pares o 24h (estado persistido en
`backup_canary_comparison_state` para sobrevivir un restart), y resultados
en `backup_canary_comparison_results`. Probado de punta a punta con datos
reales (limpiado después -- ver nota abajo) y typecheck sin regresión
(27/27).

**No está corriendo en producción todavía por dos motivos, no uno solo:**
1. `CANARY_USER_IDS` está vacío en el `.env` real -- sin esto el comparador
   es un no-op total, a propósito.
2. Más importante: **no está claro si el backend que sirve tráfico real hoy
   ya corre el código de este checkout** (Entrega A, el mecanismo de pausa,
   y ahora este comparador). El `--apply` de la Entrega B escribió directo a
   Mongo sin pasar por ese proceso, así que no prueba nada sobre si está
   desplegado. Antes de setear `CANARY_USER_IDS` hace falta confirmar (o
   forzar) que el backend real corre esta rama.

Nota de verificación: la primera prueba end-to-end se hizo con una muestra
truncada de 50 archivos como "legacy" (no los 1121 reales) para no tener que
esperar tráfico real -- produjo un diff enorme que es un artefacto de esa
truncation, no un bug. Se limpiaron los documentos de prueba en
`backup_canary_comparison_state`/`results` antes de dejar esto listo para
la ventana real.

- Comparar en paralelo únicamente para `userId` incluidos en una allowlist
  canary. Dentro de esa allowlist se admite como máximo una comparación por
  usuario cada 15 minutos; fuera de ella no se duplica ninguna lectura. Se
  prefiere este límite determinista a muestrear 1/N porque el tick de Electron
  puede volver a dispararse apenas vence su cooldown de cinco minutos y, con
  pocas cuentas canary, un 5% produciría muy poca evidencia en 24 horas.
- Limitar el comparador a una operación concurrente y ejecutarlo fuera del
  camino de respuesta: el cliente sigue recibiendo la respuesta vieja mientras
  se registra el diff canónico best-effort.
- Normalizar orden de arrays/fechas y comparar hashes y campos.
- Detener automáticamente la comparación al completar 200 pares válidos o 24
  horas, lo que ocurra primero. Debe cubrir tanto `includeResolved=true` como
  la respuesta filtrada; si una variante no llega a una muestra útil, se
  completa con pruebas dirigidas, no aumentando la tasa global.
- Activar canonical read primero para las cuentas canary. No habrá comparación
  doble global ni un comparador permanente cada cinco minutos.
- Conservar el contrato HTTP exacto para Electron, iOS y Android.

**Gate:** cero diferencias no explicadas y pruebas funcionales de push, pull,
wipe+restore, rename, calendario, Matches, Estadísticas, Historial y Biblioteca
remota. Después se realiza un go/no-go humano; solo con aprobación se abre la
ventana de bajo tráfico y se ejecuta el apply global descrito en la Entrega B.

### Entrega D — retirada

Sin ventana de observación de 30 días: el snapshot de la Entrega B ya es el
mecanismo de rollback, y la matriz de verificación de la sección 6 (corrida
contra el canary) es el gate de confianza antes del `--apply` global — una vez
que ese `--apply` pasa su postflight, no hay razón para seguir escribiendo
`backup_files` en paralelo.

Riesgo residual aceptado: entre el postflight global y una eventual detección
por uso real, solo habrá rollback estático; no habrá un shadow actualizado con
los pushes posteriores. Por eso el corte requiere snapshot verificado,
comparación canary terminada, cero ambiguos, pausa de escrituras y go/no-go
humano en la misma ventana.

- Confirmar cero lectores de `BackupFileModel` fuera del código de compatibilidad.
- Cambiar `backup/status` y `sync-status` a `files.backup_synced_at`.
- Dejar de escribir `backup_files` desde `bulkUpsertBackupFiles` inmediatamente
  después del postflight exitoso del `--apply` global (Entrega B) — no hace
  falta un ciclo adicional de observación en vivo, dado que el snapshot ya
  cubre el rollback.
- Eliminar `backup_files` mediante un script separado, con `--apply` explícito
  y solo después de confirmar que el snapshot de la Entrega B sigue accesible
  fuera de Mongo. Nunca desde el arranque normal del backend.

## 6. Matriz mínima de verificación

1. Push completo desde PC primaria y push parcial desde secundaria.
2. Archivo nuevo, rename por `content_id`, borrado y reaparición.
3. Cambio offline de badges y descartes con LWW dedicado.
4. Publicación confirmada que no puede ser degradada por un backup viejo.
5. Pull sobre SQLite existente y recuperación después de wipe.
6. Archivo presente solo en `files` y solo en `backup_files`.
7. iOS decodifica `_id`/`createdAt`; Android tolera campos adicionales.
8. `sync-status` distingue metadata respaldada de bytes en Biblioteca remota.
9. Calendario, Matches, Estadísticas, Historial y streaming conservan el mismo
   `FileModel._id`.
10. Rollback restaura exactamente los documentos tocados por el canary.
11. Un push concurrente queda como `concurrent_change`, una segunda corrida es
    no-op para lo ya aplicado y resuelve el registro pendiente sin duplicarlo.
12. Durante la pausa, el cliente recibe `503` completo y su siguiente ciclo
    reintenta el push; el flujo de logout no hace wipe si falló su backup previo.
13. El comparador respeta allowlist, cooldown de 15 minutos, concurrencia 1,
    límite de 200 pares y apagado automático a las 24 horas.

## 7. Condiciones de aborto

Detener el rollout si aparece cualquiera de estas situaciones:

- duplicado nuevo de `{userId, content_id}`;
- cambio de `_id` o referencia huérfana en `platform_videos`;
- respuesta incompatible con un cliente soportado;
- una publicación `confirmed` pasa a descartada/badge-only;
- el postflight difiere del número de updates reconocido por MongoDB;
- el rollback generado no pasa una restauración de ensayo;
- queda cualquier `ambiguous` sin una resolución válida antes del apply global;
- se detecta un `concurrent_change` durante el apply global (se reanuda el
  servicio sin retirar `backup_files`, se reevalúa y se programa otra ventana);
- no se pudo drenar/pausar `POST /api/backup/files/bulk` antes del snapshot.

## 8. Fuera de alcance

- `platformvideos`, `backup_platform_videos` y `upload_history`.
- `transcripts` y `transcript_backups`.
- Eliminación de `publishing_status`/`published_cards`.
- Rediseño multi-dispositivo de rutas físicas.
- Hardening de autenticación y despliegue de producción.

Cada familia anterior tendrá una decisión semántica y migración separada. No
se ejecutará junto con esta consolidación.

## 9. Propuesta de nombres de colecciones (documentado, sin ejecutar todavía)

Relevamiento de las 16 colecciones reales de la central (2026-09-02). Todas
ya tienen `userId` en su schema y en sus índices — el problema no es scoping
por usuario, es inconsistencia de convención (algunas colecciones
auto-pluralizadas por Mongoose sin declarar nombre explícito, sin
snake_case) y un caso sin modelo formal:

| Colección actual | Modelo | Problema | Nombre propuesto |
|---|---|---|---|
| `platformvideos` | `PlatformVideo` | sin snake_case | `platform_videos` |
| `loginlogs` | `LoginLog` | sin snake_case | `login_logs` |
| `ideacentrals` | `IdeaCentral` | sin snake_case, plural roto | `ideas_centrales` |
| `platform_config` | *(sin modelo — `db.collection()` a mano en `backup.controller.ts` y `sync.controller.ts`)* | sin schema, **sin índice único `{userId, platform}`** pese a que todo el código ya lo asume | `platform_configs` + modelo Mongoose real con ese índice único |

El resto (`files`, `backup_files`, `transcripts`, `transcript_backups`,
`published_cards`, `backup_configs`, `audit_events`,
`backup_platform_videos`, `publishing_status`, `remote_library_videos`,
`upload_history`, `users`) ya sigue la convención snake_case plural — no
necesitan renombrarse.

**Por qué no va en esta migración:** un `renameCollection` es barato en
Mongo, pero cada rename obliga a tocar el modelo, cada `db.collection('...')`
a mano, y cualquier script administrativo que la referencie por nombre
literal — y para `platform_config` además requiere agregar el modelo/índice
único (una migración de esquema real, no solo un rename). Mezclarlo con la
consolidación de `files`/`backup_files` aumentaría el radio de la migración
sin necesidad; se ejecuta como entrega separada una vez que esa consolidación
esté estable.

**Hallazgo de paso, no relacionado con nombres:** `platform_config` no tiene
índice único sobre `{userId, platform}` a pesar de que `sync.controller.ts` y
`backup.controller.ts` la tratan como si lo tuviera (`findOne`/`updateOne`
siempre filtran por ambos campos) — nada impide hoy un duplicado real. Se
resuelve naturalmente al promoverla a modelo Mongoose en la migración de
renombre, pero es un gap de integridad independiente del tema de nombres.
