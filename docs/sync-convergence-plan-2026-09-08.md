# Plan de convergencia de sincronización — 2026-09-08

Plan de ejecución derivado de [`sync-reconciliation-map-2026-09-08.md`](./sync-reconciliation-map-2026-09-08.md)
(el informe de auditoría: dónde vive cada hecho, qué par reconcilia qué, y
dónde no hay ninguna regla). Este archivo es el **qué hacer**; el informe es
el **qué encontramos**.

## Diagnóstico en una línea

El mismo hecho ("este video está publicado en TikTok con este link") vive en
~11 representaciones, cada par tiene su regla de reconciliación escrita a mano
en un `if` distinto, y los bugs viven en los pares sin regla. En dos casos, dos
reglas correctas por separado **se componen en un ciclo de reversión
determinista**.

## Decisiones tomadas (cerradas, no volver a discutir sin dato nuevo)

| Tema | Decisión | Por qué |
|---|---|---|
| `pending` | **No es un estado nuevo.** Significa plataforma ausente de `platform_states`. | El enum es `confirmed \| badge_only \| discarded` ([platform-state.util.ts](../backend/src/utils/platform-state.util.ts)); un 4º valor obliga a migrar, y buena parte del catálogo histórico ni siquiera tiene el campo poblado. |
| Clave de mutación | **`content_id`**, no un `remote_file_id` nuevo. | Ver "Evidencia" abajo. |
| `fileName` | **Nunca** para ejecutar mutaciones. Solo para *detectar* candidatos en el reconciliador. | Ya causó daño real: `final -` vs `FINAL -` creó dos documentos; `final  - sufre.mp4` (doble espacio) rompió el Calendario. Una búsqueda exacta devuelve **un** resultado y es el equivocado. |
| Arrays vs `platform_states` | Los arrays (`platforms`/`platforms_discarded`) siguen siendo **proyecciones materializadas**, no se derivan al leer. | `platform_states` no está poblado en el catálogo viejo: usarlo como fuente daba 1061 pendientes falsos en vez de ~65 (ver comentario en `getCrossMatchCandidates`). |
| Escritor | **Uno solo.** Todos los callers actuales pasan a rutear por él. | Un servicio que escribe bien las 6 representaciones pero convive con otros 6 escritores es complejidad agregada, no consolidación. |
| Relojes por hecho | **Después** de centralizar escritores, nunca antes. | Un reloj solo sirve si *todos* los escritores lo actualizan. Es exactamente lo que ya falló: hoy solo `bulkUpsertBackupFiles` escribe `platforms_updated_at`, así que no había con qué comparar. |
| Reparación histórica y canary | **El mismo mecanismo.** | El reconciliador que repara es el mismo reporte que mide divergencia para la consolidación. |
| Orden push/pull | **No invertirlo todavía.** | Es barato pero no es el arreglo: arrastra los tres criterios del pull (escritos asumiendo el orden actual) y no elimina el ciclo, porque el push post-publicación se dispara fuera del orquestador desde 6+ callers. |
| Intención del usuario | **Contrato de transición explícito**, nunca inferida de un snapshot. | Ver "Propuesta rechazada" abajo. |
| `unlink` en el espejo | **Tombstone**, no borrar la fila. | `pullPlatformVideosFromCloud` no borra NUNCA filas locales ausentes de la respuesta (verificado: cero eliminaciones en esa función). Si la fila del espejo simplemente desaparece, un segundo dispositivo que ya tenía el link local no se entera jamás y lo conserva para siempre. |
| Atomicidad | **Outbox + idempotencia**, no transacciones de Mongo. | Ver "Transacciones vs outbox" abajo. |

### Propuesta rechazada: inferir la intención diffeando el snapshot

Se propuso que `updateFilePlatforms` comparara el estado recibido contra el
actual y tratara cada diferencia como acción explícita. **Rechazado**: un
snapshot completo no permite distinguir "el usuario tocó esto" de "este cliente
venía desactualizado". Una PC o un móvil atrasado degradaría varios `confirmed`
de una sola vez, accidentalmente — o sea, arreglaríamos el bug 2 abriendo una
vía nueva para exactamente el mismo daño.

La solución es cambiar el contrato, no adivinar mejor:

```
POST /api/sync/platform-transition
{ contentId, platform, action, operationId, occurredAt }
```

Acciones: `mark_badge_only`, `discard`, `clear_resolution`, `unlink`.
`confirm` con link real **sigue entrando por `applyPlatformPublish`**. Para
ediciones múltiples, `operations[]`.

`updateFilePlatforms` se mantiene para clientes viejos como **snapshot
automático conservador**: puede completar información, nunca degradar un
`confirmed`. Los clientes nuevos mandan la acción puntual que el usuario hizo.

### Transacciones vs outbox

Las 5 escrituras del servicio son secuenciales y sin atomicidad. Medido: el
Mongo local de desarrollo (Docker, `mongo:8.0`) es **standalone**, así que no
soporta transacciones multi-documento — se podrían usar en producción (Atlas es
replica set) pero **el harness no podría verificarlas**, que es justo lo que no
queremos.

Se elige **outbox + idempotencia**:

- El fallo que realmente nos mordió (el unlink que nunca llegaba) es de
  contrato/red **entre Electron y la central**, fuera del alcance de cualquier
  transacción de Mongo. Una transacción resolvería un riesgo más chico que el
  que tenemos.
- `operationId` ya está en el contrato propuesto, y el repo ya tiene el patrón
  hecho (`history_outbox`, SQLite local durable) para copiar.
- Las 5 escrituras ya son "poner en este valor" (no incrementos), así que un
  reintento las repara sin necesidad de rollback.

Si más adelante se quieren transacciones igual, convertir el contenedor a
replica set de un solo nodo es un cambio chico.

### Evidencia: por qué `content_id` y no `remote_file_id`

Medido contra producción el 2026-09-08:

| | Archivos con `content_id` |
|---|---|
| SQLite local | 1123 de 1123 activos (100%) |
| Central (`files`) | 1129 de 1129 activos (100%) |

Los 30 documentos centrales sin `content_id` son **todos** `ELIMINADO_DISCO`
(archivos borrados del disco, nunca destino de una mutación). Y el índice
necesario ya existe: `{userId, content_id}` **único**, parcial sobre valores
string.

O sea: el identificador compartido, único y estable **ya existe en los dos
lados, con índice**. `remote_file_id` habría sido una columna nueva + backfill
+ un campo más que puede desincronizarse, para conseguir lo que `content_id` ya
da. Además `setPlatformLink` ya tiene `file.content_id` a mano: Electron puede
mandarlo sin ningún cambio de esquema.

Dos cuidados que **no** cambian la conclusión:

- Tras un wipe/reinstalación el `content_id` local se regenera (nace random y
  el pull lo cura por nombre). En esa ventana una mutación por `content_id`
  daría 404 — el fallo *correcto*, ruidoso. Un `remote_file_id` cacheado
  tampoco sobreviviría al wipe.
- El endpoint hoy recibe `:fileId`. Al pasar a `content_id` debe **rechazar con
  400 explícito** lo que no tenga forma de content_id, en vez del 500 por
  CastError actual. Como nunca funcionó, no hay regresión posible.

## Reglas del dominio

| Acción | Estado central resultante |
|---|---|
| `confirm` | Con link · badge presente · `confirmed` |
| `unlink` | Sin link · sin badge · **ausente** de `platform_states` (= pending) |
| `discard` | Sin link · sin badge · `discarded` |
| Push automático atrasado | **Nunca** puede sobrescribir una acción explícita más reciente |

La distinción que falta hoy y que habilita todo lo demás: **acción explícita
del usuario** vs **push automático**. Una acción explícita SÍ puede degradar un
`confirmed`; un backup automático no. Hoy la protección de `confirmed`
(BUG-2026-09-06-04) no puede distinguirlas, y por eso existe el bug 2.

> Esa intención ya estaba escrita como comentario en `platform-state.util.ts`
> — *"Si el usuario quiere descartar algo ya confirmado de verdad, es una
> acción explícita que debe pasar por el mismo platformId/link, no por este
> path"* — pero nunca se implementó el camino que la hiciera cumplible.

## Entregas

### Entrega 1 — Demostrar y cerrar los bugs 1 y 2

**1.1 · Tests rojos primero — HECHO** (rama `test/sync-convergence-red`)

Tres tests que fallan contra el código de producción real (importan y ejecutan
los handlers, no reimplementan las reglas):

| Tramo | Archivo | Qué demuestra |
|---|---|---|
| Electron manda el unlink | `local-backend/src/controllers/sync-convergence.test.ts` | Manda el id entero de SQLite donde la central filtra por `_id` de Mongo |
| Push de catálogo | `backend/src/controllers/sync-convergence.test.ts` | `platforms_discarded: ["instagram"]` → `[]` |
| Pull | `local-backend/src/controllers/sync-convergence.test.ts` | `platforms_discarded: ["instagram"]` → `[]` |

**1.1b · Harness integral — HECHO** (`backend/src/controllers/sync-integral.test.ts`)

El test del pull que hardcodeaba la respuesta *buggy* de la nube fue retirado:
probaba la reproducción del incidente, no el contrato, y habría seguido rojo
aunque el bug se arreglara. Lo reemplaza un harness que enruta el `fetch` de
local-backend a los **controladores reales** de la central, en el mismo
proceso: cero respuestas simuladas.

Correcciones aplicadas tras review, todas por el mismo motivo — un harness que
pueda ponerse verde sin garantizar el comportamiento es peor que no tenerlo:

| Problema | Corrección |
|---|---|
| La "segunda PC" solo hacía pull | Ciclo completo push→pull. Una PC real pushea primero, y ese push viejo puede pisar el tombstone antes de leerlo — por eso **tombstone y LWW de links van juntos** |
| Ruta desconocida devolvía `200 {}` | Devuelve **404** y se registra; cada test afirma que no quedó ninguna. Si no, una ruta nueva (`/api/sync/platform-transition`) se daría por entregada sin despacharse jamás |
| Los casos 2 y 3 heredaban estado del 1 | Cada test limpia SQLite + Mongo y siembra lo suyo |
| El push de fondo (`setImmediate`, sin handle) corría durante el ciclo siguiente | `waitIdle()` drena el macrotask y espera a que no queden fetch en vuelo |

**Gate de merge.** Con el skip por defecto, no tener Mongo daba *3 skips y exit
code 0*: un merge se veía verde sin haber probado nada. Ahora:

- `npm test` — mantiene el skip, para desarrollo normal.
- `npm run test:integration` — `ESSE_REQUIRE_MONGO=1`, **falla** si no hay
  Mongo. Es lo que tiene que correr el pipeline antes de mergear.

**Pendiente antes del merge:** el harness está excluido del `tsconfig` de
backend (cruza a `local-backend` y arrastraba sus ~47 errores al typecheck de
este paquete, 22 → 55, tapando la señal). Necesita un chequeo propio.

**1.2 · Servicio central de transición**

Operación única con comandos explícitos, keyed por `content_id`:

```
confirm(userId, contentId, platform, link)
unlink(userId, contentId, platform)
discard(userId, contentId, platform)
```

Actualiza coherentemente `files`, `backup_files` (mientras exista),
`platformvideos`, `backup_platform_videos`, `remote_library_videos`,
`platform_states` y `platforms_updated_at`.

`upload_history` y `audit_events` **no se tocan**: son historial, no estado
actual.

**1.3 · Rutear todos los escritores**

Deben pasar por el servicio: `applyPlatformPublish`, `updateFilePlatforms`,
`unlinkPlatform`, el mirror de remote-library, `resolveCrossMatchSlot` y el
push de catálogo. Al cerrar la entrega no debe quedar ninguna escritura directa
a `platforms`, `platforms_discarded` o `platform_states` fuera del servicio,
salvo migraciones identificadas.

**1.4 · Dejar de tragarse el error**

`upload-history.service.ts` loguea el fallo con `console.warn` y sigue. Electron
tiene que recibirlo y mostrarlo.

**Criterio de aceptación**

- Los tres tests quedan verdes.
- Tres ciclos consecutivos push/pull no revierten el cambio.
- Repetir una operación no altera el resultado (idempotencia).
- Un id local nunca llega a una consulta de Mongo.
- Un push automático no degrada `confirmed`.
- Una acción explícita **sí** puede retirar o descartar un `confirmed`.

### Entrega 2 — Reconciliador y reparación histórica

Comando `reconcile-platform-state`, dry-run por defecto. Detecta: arrays que
contradicen `platform_states`; `confirmed` sin `PlatformVideo`; links a
archivos sin badge; links desvinculados que siguen apuntando vía
`backup_platform_videos`; diferencias entre `files`, `backup_files` y
`remote_library_videos`; colisiones de nombres normalizados.

Salida: conteos por categoría, IDs afectados, acción propuesta, ambiguos
aparte. Reparación por categoría o por IDs explícitos, **nunca** global a
ciegas. Este mismo reporte es el canary de la Entrega 5.

### Entrega 3 — Relojes por hecho

Solo cuando *todos* los escritores usen el servicio central, que pasa a ser el
único responsable de moverlos: `platforms_updated_at`, `link_updated_at`,
`content_updated_at`, y se conserva `statsSyncedAt`.

Además: LWW faltante en `files`; LWW faltante en `backup_platform_videos`;
propagación explícita de `null` como desvinculación (hoy `?? existing` confunde
"ausente" con "borrado"); valor y timestamp siempre de la misma colección.

### Entrega 4 — Fallos secundarios

`match_status` degradándose en el pull; `scheduled_date: null` que no propaga;
`published_cards` con fechas regresivas; operación de "des-descartar"; revivir
`ELIMINADO_DISCO` por coincidencia de nombre; las dos representaciones del
calendario (`platform_config` y `backup_configs.platform_configs`, que nunca se
hablan). Cada uno entra con su test de regresión.

### Entrega 5 — Consolidación

Cuando el reconciliador reporte cero divergencias relevantes: canary con
`BACKUP_CANONICAL_READS` → 24 h de observación → lectura definitiva desde
`files` → retirada de `backup_files` → evaluar `backup_platform_videos`.
Rollback por flag durante una versión completa.

> Ojo con el orden: la Entrega 3 es **prerequisito** de ésta. El informe
> sospecha que el LWW faltante en `files` es justamente lo que el canary está
> midiendo como divergencia — sin arreglarlo, el canary no puede converger y se
> espera para siempre.

## Riesgos y cosas a vigilar

- **El escritor único no elimina los otros escritores por sí solo.** Si la
  Entrega 1.3 queda a medias, quedan 7 escritores en vez de 6 y el problema
  empeora. 1.2 sin 1.3 no es un entregable.
- **La Entrega 3 depende en silencio de la 1.3.** Los relojes solo funcionan si
  el servicio es el único que escribe.
- **El test del pull necesita rediseño** antes de poder usarse como criterio de
  aceptación (ver 1.1).

## P0 — CERRADOS (con sus 5 casos en verde)

Los tres huecos señalados sobre `a80ca41`, cada uno con su regresión:

| P0 | Qué fallaba | Cómo se cerró |
|---|---|---|
| Caída entre `pending` y el CAS | `reanudando` daba por hecho que el CAS ya había corrido; si la caída ocurría en el medio, la revisión no se incrementaba nunca | La señal ya no se infiere: `resultVersion` se escribe **en el momento del claim**, y su presencia es lo que dice si el claim ocurrió |
| El CAS no cubría las proyecciones | Protegía el claim y terminaba ahí; una publicación podía entrar antes del `$pull` y la transición vieja la destruía | **Todas** las escrituras van condicionadas a `platform_rev.<plataforma> === versión reclamada`. Si alguien la movió, no matchean y la operación corta con 409 |
| `operationId` con otro payload | Podía reanudar o dar por completada una operación distinta | Se valida que `contentId`, plataforma, acción y `baseVersion` coincidan con el registro; si no, **422** (no 409: reintentar nunca lo va a arreglar) |

Además: el `POST` ahora **exige** `operationId` y `baseVersion >= 0`, y
`applyPlatformPublish` dejó de reemplazar `platform_states` desde una foto
previa.

### Lección: un test de concurrencia que pasa no prueba nada

El caso "transición y publish concurrentes" pasaba con un `Promise.all` a
secas -- pero solo porque la carrera no llegaba a darse. Al **forzar** el
intercalado (stub que mete la transición justo entre la lectura y la escritura
de `platform_states`), falló de inmediato y confirmó el lost update. Los tests
de concurrencia de este harness fuerzan el intercalado; no lo esperan.

### Instancia restante del mismo patrón, sin cubrir

`applyPlatformPublish` sigue haciendo read-modify-write de `platformStates`
sobre **`RemoteLibraryVideoModel`** (`backup.controller.ts`, el
`upsertConfirmed` del mirror de Nube). Es el mismo bug que se acaba de corregir
en `FileModel`, en la misma función, y **no tiene test todavía**. Red primero
antes de tocarlo.

## Semántica de la transición (parcial — ver P0 arriba)

`POST /api/sync/platform-transition` — `{ contentId, platform, action,
operationId?, baseVersion? }`. Convive con el `DELETE` viejo, que se conserva
para clientes que todavía no lo usan pero **no puede declarar ni `operationId`
ni `baseVersion`** (lleva la clave en el path y nada más).

| Pieza | Decisión | Por qué |
|---|---|---|
| Autoridad de precedencia | **`baseVersion`**, revisión causal que emite el servidor | El reloj del cliente no sirve: se desfasa. En este mismo repo se midió una deriva de 5 h por zona horaria (BUG-2026-09-08-01). Una máquina adelantada podría declararse "más nueva" y pisar un cambio posterior. |
| Dónde vive la revisión | `FileModel.platform_rev`, **mapa** `{instagram: 3}` | `$inc` por path es atómico y no toca las otras claves. El array anterior se leía, modificaba en JS y reescribía entero: dos plataformas concurrentes se pisaban. |
| Exclusión entre operaciones | **CAS** sobre la revisión de esa plataforma | Dos transiciones sobre la MISMA plataforma no pueden ganar las dos: la segunda no matchea la revisión que leyó y sale por 409. |
| Deduplicación | Colección `platform_transition_ops`, único por `(userId, operationId)` | `operationId` sin registro no deduplica nada: cada reintento reaplica efectos. Con una outbox reintentando, eso pasa siempre. |
| Operación a medias | Se registra `pending` **antes** de aplicar; se marca `completed` **después** de las 5 proyecciones | Marcarla antes sería mentir: una caída en el medio la dejaría como hecha y nadie la reanudaría. Las escrituras son idempotentes, así que reanudar converge sin rollback. |
| Escritura de proyecciones | `$pull`/`$addToSet` **acotados a la plataforma** | Calcular los arrays en JS y escribir con `$set` es read-modify-write del documento entero: lost update medido entre plataformas distintas. |
| `stateChangedAt` | Informativo, no decide nada | Queda para diagnóstico. |
| Respuesta a operación vieja | **409** + `version` vigente | Con 404 una outbox reintenta eternamente algo que nunca va a aplicarse. |

Se eliminó `applyExplicitTransition` (núcleo puro que calculaba arrays en JS):
quedó sin uso al pasar a operadores atómicos, y sus 7 tests unitarios pasaban
sin cubrir nada. Sus garantías se mudaron al harness, contra el camino real.

## Estado

| Paso | Qué | Estado |
|---|---|---|
| 1.1 / 1.1b | Tests por tramo + harness integral + gate `test:integration` | Hecho |
| 1.2 | Escritor único (`applyPlatformTransition`) | Hecho |
| 1.3 | Rutear los 6 escritores | **1 de 6** (`unlinkPlatform`) |
| 1.4 | Propagar el error a Electron | Hecho para el unlink |
| 6 | Tombstone de desvinculación | Hecho |
| 7 | LWW de links + precedencia por plataforma | Hecho |
| 7b | Semántica causal: dedup persistente, CAS, reanudación, endpoint POST | **Parcial** — 3 P0 abiertos |
| 8 | Outbox local (intención durable) | **Sin empezar** |
| 9 | Outbox central (reparación de escrituras parciales) | **Sin empezar** |
| 2 a 5 | Reconciliador, relojes restantes, fallos secundarios, consolidación | Sin empezar |

### Harness: 17 tests, 0 skips, todos verdes

Unlink y descarte explícitos sobreviven 3 ciclos en las 6 representaciones ·
segunda PC recibe el tombstone pese a su propio push viejo · re-vincular el
mismo `platformId` limpia el tombstone · el tombstone se crea aunque no hubiera
fila previa · transición sobre revisión vieja → 409 con la revisión vigente ·
reintento idéntico no reaplica · entrega invertida: gana la causalmente
posterior · plataformas concurrentes no se pisan · operación cortada a la mitad
se reanuda hasta converger · semántica de unlink/discard · el snapshot
automático NO degrada un `confirmed`.

### Pendiente antes del merge

- Rutear los 5 callers que faltan (1.3). Hoy hay 7 escritores, no 1.
- El harness está excluido del `tsconfig` de backend (cruza a `local-backend` y
  arrastraba sus ~47 errores, 22 → 55). Necesita chequeo propio.
- Correr `npm run test:integration` en el pipeline, no `npm test`.
- Los clientes todavía no mandan `baseVersion`/`operationId`: sin eso la
  precedencia y la deduplicación no se ejercitan en producción. Es lo que
  aporta la outbox local.
