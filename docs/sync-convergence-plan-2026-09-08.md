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

## P0 — CERRADOS (dos rondas, 25 casos en verde)

### Ronda 1

| P0 | Cómo se cerró |
|---|---|
| Caída entre `pending` y el CAS | La señal dejó de inferirse del estado de la operación |
| El CAS no cubría las proyecciones | La primera escritura de `files` quedó condicionada a la versión reclamada |
| `operationId` con otro payload | Se valida `contentId`/plataforma/acción/`baseVersion`; si no coinciden → **422** |

### Ronda 2 — lo que quedó DETRÁS de ese verde

| P0 | Qué fallaba | Cómo se cerró |
|---|---|---|
| Claim no atómico entre documentos | El CAS iba en `FileModel` y `resultVersion` en la operación: una caída entre las dos dejaba la revisión movida y la operación sin marca, y al reintentar se rechazaba **a sí misma** por `stale` | `platform_claim` se escribe **en el mismo update del CAS**. O están las dos cosas o ninguna |
| El guard solo protegía `files` | `backup_files`, `platformvideos`, tombstones y Nube escribían sin condición | Cada proyección se **sella** con la versión (`platform_rev`, `link_version`, `platformRev`) y solo acepta escrituras `>=` a la que ya tiene |
| Lost update en el mirror de Nube | `applyPlatformPublish` reemplazaba `platformStates`/`platformLinks` desde una foto previa | `$pull`/`$addToSet` acotados, y además **sella la revisión en Nube** para que una transición vieja no la pise |
| Entrega simultánea idéntica daba 409 | Aceptar 409 no demuestra deduplicación: el cliente puede creer que su operación se perdió | Si el CAS lo pierde otra entrega **de la misma operación**, se responde `deduplicated`, no conflicto |

### Dos errores propios que encontraron los tests, no la lectura del código

1. **El alcance se leía tarde.** Los `platformId` que la operación puede soltar
   se leían *después* de las primeras escrituras, así que una publicación
   intercalada entraba en esa lista y la transición terminaba desvinculándola.
   Ahora el snapshot se toma antes del claim.
2. **Y no podía recalcularse al reanudar.** Al mover la lectura antes, la
   reanudación la recomputaba y volvía **vacía** (el intento anterior ya había
   soltado los vínculos), así que no terminaba de aplicar. El alcance es parte
   de la identidad de la operación: se **persiste** en su registro.

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
| 8 | Outbox local (intención durable) | Hecho para el unlink |
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

---

## Entrega 2 — OUTBOX LOCAL (6 casos nuevos en verde)

### El agujero, concretamente

`reportUnlinkPlatform` hacía el `DELETE` contra la central y, si fallaba,
lanzaba; `setPlatformLink` lo atrapaba y devolvía un `syncWarning` en el JSON.
Ahí terminaba todo. La SQLite local ya estaba desvinculada, la central nunca se
enteraba, y **no quedaba nada que reintentar** -- ni en ese momento ni nunca.
El usuario veía el link desaparecer y el próximo pull podía resucitarlo, porque
del otro lado no había pasado nada.

Es el mismo agujero que `history_outbox` ya había tapado para el historial
(BUG-2026-08-15-07), en otra ruta.

### Qué se agregó

| Pieza | Dónde | Para qué |
|---|---|---|
| `transition_outbox` | SQLite local | La intención se guarda ANTES de intentar entregarla |
| `platform_revisions` | SQLite local | La revisión que esta PC vio, para poder declarar `baseVersion` |
| `GET /api/sync/platform-revisions` | central | Sin esto el cliente no conoce la revisión y no puede usar el endpoint de transición |
| `flushTransitionOutbox` | local-backend | Reintento, colgado de los mismos disparadores que el outbox de historial (arranque + push de fondo) |

Tres decisiones que no son obvias:

1. **La revisión se congela al ENCOLAR, no al entregar.** Releerla al entregar
   convertiría una desvinculación decidida ayer, sobre el estado de ayer, en una
   desvinculación aplicada contra el estado de hoy -- borrando una publicación
   que entró en el medio. Es exactamente la familia de bugs que motivó todo
   esto.
2. **El reintento reusa el mismo `operationId`.** Con uno nuevo, un reintento
   tras una respuesta perdida sería para la central otra operación: o reaplica
   los efectos, o la rechaza por atrasada y el usuario ve un conflicto sobre
   algo que ya se había aplicado bien.
3. **Los flushes se encadenan, no se descartan.** El guard obvio ("si ya hay uno
   corriendo, salteá") hacía que la segunda llamada volviera sin saber si la
   primera había alcanzado a ver su fila -- `findPending` ya había leído su lote
   antes de que la fila existiera. Producía un aviso de "quedó pendiente" sobre
   desvinculaciones que se estaban entregando bien.

### Los 6 casos

| Caso | Qué afirma |
|---|---|
| OUT-1 | Un unlink decidido con la central caída se entrega solo cuando vuelve la red |
| OUT-2 | Si se pierde la RESPUESTA, el reintento se entrega y no reaplica nada |
| OUT-3 | Una intención encolada no destruye lo que se publicó mientras esperaba |
| OUT-4 | Un 409 se archiva; un fallo de red sigue pendiente |
| OUT-5 | Dos intenciones sobre la misma plataforma se entregan en orden |
| OUT-6 | Un flush ya en vuelo no hace que la desvinculación se reporte como pendiente |

### Verificado por mutación, no solo por color

Dos de los seis casos pasaban **por el motivo equivocado** y lo destapó romper
la implementación a propósito, no leer el código:

- **OUT-2** pasaba aunque el reintento se presentara con un `operationId` nuevo:
  la central lo rechazaba por atrasado y la revisión tampoco avanzaba, así que
  el assert de "no se aplicó dos veces" se cumplía igual. Ahora exige que se
  ENTREGUE (`delivered`), no que simplemente no empeore.
- **OUT-3** no distinguía "base congelada" de "base releída": esta PC nunca se
  había enterado de la publicación nueva, así que releer daba el mismo número.
  Ahora corre un ciclo de sync en el medio, para que la PC SÍ conozca la
  revisión nueva y la operación encolada tenga que salir igual con la vieja.

Las 6 mutaciones (sacar el disparador, id nuevo por reintento, base releída,
409 reintentado, sin orden por clave, guard en vez de cola) rompen cada una su
caso.

### Estado

31 tests en verde en `backend` (26 integrales + 5 de convergencia), 0 skips,
exit 0 contra Mongo real. `tsc` backend 22 / local-backend 47 (baseline).
local-backend 2/2.

De paso: `waitIdle` del harness solo drenaba `setImmediate`, y 100 turnos no
alcanzan para un push completo contra Mongo real -- declaraba "no terminó
nunca" algo que solo estaba tardando. Ahora cede tiempo real, con presupuesto
acotado para que un cuelgue de verdad siga siendo un error.

---

## Entrega 2b — cerrar la outbox de verdad (8 casos nuevos)

La revisión independiente encontró que la outbox mejoraba el sistema pero
todavía no era una outbox transaccional, y que el commit anterior no había
tocado el servicio central. Ocho casos nuevos, rojos primero.

### Cuatro huecos del servicio central

| Hueco | Qué pasaba | Cómo se cerró |
|---|---|---|
| Claim viejo tras un publish | `applyPlatformPublish` mueve la revisión y no borra `platform_claim`. Una entrega atrasada se reconocía como reanudación, y reanudar SALTEA `baseVersion` y el CAS: se aplicaba sobre la revisión nueva y destruía la publicación | El claim guarda `{ op, rev }`. Si la revisión se movió, caduca solo -- ningún otro escritor tiene que acordarse de limpiarlo, que es lo que no se puede garantizar con 7 escritores |
| `platformIds: []` recalculado | Un alcance legítimamente vacío se leía como "todavía no se calculó" y se recalculaba al reanudar, llevándose puesto lo aparecido mientras tanto | Se pregunta si el alcance ESTÁ (`Array.isArray`), no si tiene elementos |
| Upsert del tombstone sin guard | El `updateMany` comparaba `link_version`; el `updateOne` con upsert que sigue no comparaba nada y pisaba re-vínculos más nuevos | El guard va también en el filtro del upsert; el `E11000` resultante es la prueba de que hay una fila más nueva que no hay que tocar |
| `200 deduplicated` prematuro | El claim se escribe al RECLAMAR, no al terminar. La gemela podía estar a mitad de las proyecciones y el cliente daba la fila por entregada | "Deduplicada" exige `status === 'completed'`. Mientras no terminó: **202 `in_progress`** |

### Y tres propiedades que faltaban del lado del cliente

- **Transacción SQLite.** Soltar el vínculo, sacar el badge y encolar la
  intención son el mismo hecho. Estaban en tres escrituras sueltas, la tercera
  desde otra función: una caída en el medio dejaba justo lo que la outbox venía
  a eliminar. Ahora van en una `db.transaction()`, y la entrega arranca después
  del commit. Si no se puede encolar, no se aplica nada y el cliente recibe 500.
- **Estado y revisión observados juntos.** El pull traía los archivos y después,
  en otra llamada, las revisiones. Entre las dos respuestas cabía una
  publicación: la PC se quedaba con el estado de ANTES y la revisión de DESPUÉS,
  que es peor que estar desactualizado -- una desvinculación decidida sobre lo
  viejo salía declarando la revisión nueva y la central la ACEPTABA. Ahora
  `platform_rev` viaja dentro de `GET /api/backup/files`, y solo se adjunta
  cuando el estado servido sale del mismo documento que la revisión. El endpoint
  `GET /api/sync/platform-revisions` se **retiró**: era el que abría la ventana,
  y dejarlo disponible es dejar el error a mano.
- **Validación estricta de la respuesta.** `res.ok` cubre todo el rango 2xx, y
  ahí conviven "terminé", "la recibí" y contratos futuros. Ahora solo un 200 con
  `version` numérica cuenta como entrega; 202, otros 2xx y cuerpos que no se
  entienden siguen pendientes.

### Los 8 casos

| Caso | Qué afirma |
|---|---|
| P1-1 | Un claim viejo no se reanuda después de que otro escritor movió la revisión |
| P1-2 | Un alcance vacío no se recalcula al reanudar |
| P1-3 | El upsert del tombstone no pisa un link con revisión posterior |
| P1-4 | Una gemela no se declara deduplicada mientras la otra sigue aplicando |
| P2 | Si no se puede encolar, el cambio local tampoco se aplica |
| P3 | Una publicación llegada entre el estado y su revisión no puede ser destruida |
| P4-a | Un 202 deja la intención pendiente |
| P4-b | Un 200 sin revisión tampoco cuenta como entregado |

P0-9 se reescribió: con "deduplicada solo si terminó", la perdedora puede
responder 200 o 202 según cuándo termine la ganadora. Antes exigía `[200, 200]`,
que había pasado a depender del tiempo. Ahora exige que ninguna dé 409, que la
respuesta sea una de las dos legítimas, y que **reintentar converja** a
200 + `deduplicated`.

### Verificación

39 tests en verde (34 integrales + 5 de convergencia), 0 skips, exit 0 contra
Mongo real. Las **14 mutaciones** (6 de la ronda anterior + 8 de esta) rompen
cada una su caso. `tsc` backend 22 / local-backend 46 (bajó de 47: la llamada
vieja a `reportUnlinkPlatform` arrastraba un error de tipos que ya no existe).
local-backend 2/2.

---

## Entrega 2c — tres ventanas más (5 casos nuevos)

### 1. La reserva del `operationId` no era atómica

El registro se creaba con un `create` dentro de un try/catch que ignoraba el
`11000`. Ese catch daba por hecho que un duplicado solo puede venir de otra
entrega de la MISMA operación, y no lo verificaba: con dos requests
simultáneos los dos leen "no existe" -- así que ninguno pasa por la validación
de payload, que solo corre si ya había registro -- uno inserta y el otro se
traga el `11000` y sigue como si hubiera reservado. **La clave identificaba una
operación mientras otra, distinta, se aplicaba bajo su nombre.**

Ahora la reserva es un `findOneAndUpdate(..., $setOnInsert, upsert, new)` que
devuelve siempre el registro canónico, y lo que sigue se compara contra ÉL. El
alcance congelado también sale de ahí: si otra entrega reservó primero, congeló
SU foto, y esa es la que define qué abarca la operación.

### 2. Re-vincular el MISMO `platformId` a mitad de la transición

El alcance congelado protege de que una publicación NUEVA entre en la lista. No
protegía del caso inverso: que el mismo `platformId`, que sí estaba en el
alcance, volviera a vincularse mientras la transición avanzaba. Ese id sigue en
la lista y la transición lo soltaba igual.

Se cerró en tres capas, y las tres hicieron falta:

- **`platformvideos` gana `linkVersion`**, sellada por el publish y comparada
  por la transición. El alcance dice *qué ids* abarca la operación; la versión
  dice si el vínculo que hay ahora es *el mismo que esa operación vio*.
- **El publish sella la revisión donde antes no llegaba**: `link_version` en
  `backup_platform_videos` y `platform_rev` en `backup_files`. Esa última es la
  proyección que el publish nunca tocó -- su badge lo mantiene el push del
  escritorio -- así que su guard comparaba contra un campo que nadie escribía.
- **Chequeo de vigencia entre proyecciones.** Los sellos por documento protegen
  de que una escritura vieja llegue tarde; no protegen de que el mundo cambie
  MIENTRAS la operación avanza. La autoridad es `files.platform_rev`, y ahora se
  consulta entre proyecciones: si se movió, la operación se corta antes de tocar
  la siguiente representación.

### 3. La revisión podía viajar bajo la identidad equivocada

`getBackupFiles` mergea `backup_files` con `files` por `file_name`, y dos
documentos distintos pueden compartir nombre con `content_id` distintos
(reimportaciones, un archivo renombrado a un nombre ya usado): `centralByName`
se queda con el último que ve. Mientras eso solo movía badges era un problema
conocido de ese endpoint; con la revisión adentro es otra cosa, porque **la
revisión es la identidad del estado**. Ahora hay un índice aparte por
`content_id` que solo se usa para adjuntar `platform_rev`; el nombre sigue
siendo fallback para el resto del merge, pero sin revisión.

### Verificación, y dos guards que no probaba nadie

44 tests en verde (39 integrales + 5 de convergencia), 0 skips, exit 0. `tsc`
backend 22 / local-backend 46. local-backend 2/2.

De las mutaciones de esta ronda, **dos no rompieron nada la primera vez**:
sacar el guard de `linkVersion` y sacar el sello de `link_version` en el espejo.
El motivo era que el caso metía la re-publicación durante la escritura de
`backup_files`, y ahí lo que salvaba era el chequeo de vigencia -- la transición
se cortaba antes de llegar a esas proyecciones. Se agregaron dos casos que
meten la re-publicación DENTRO de cada una de esas escrituras, cuando el chequeo
ya pasó y lo único que queda es el sello del documento. Con esos casos, las dos
mutaciones sí rompen.

Lo mismo pasó con el alcance vacío: la invariante "presencia, no vacío" vive
ahora en dos lugares que **se cubren mutuamente**, así que mutar uno solo no
prueba nada. La mutación que vale muta los dos.

---

## Entrega 2d + paso 9 — coherencia final y outbox central

### Dos P0 previos

**El estado y la revisión podían salir de documentos distintos.** El caso
anterior solo comprobaba que la revisión no fuera la del otro archivo, y eso
dejaba pasar la mitad: el estado seguía viniendo de `centralByName` y la
revisión de `centralById`, así que se podía servir el estado de B con la
revisión de A. Una pareja que nunca existió -- y la peligrosa, porque la
revisión era la correcta para la identidad del cliente y su próxima transición
pasaba el CAS sin problema, aplicada sobre el estado de otro archivo. Ahora el
match por `content_id` manda para todo; el nombre sigue siendo fallback para el
estado, sin revisión.

**`applyPlatformPublish` no propagaba la revisión que ganó.** Incrementaba
`platform_rev` y después la releía en tres momentos distintos para sellar sus
proyecciones; una transición posterior entre medio hacía que leyera la revisión
de ELLA y sellara sus propios efectos -- más viejos -- con ese número. Ahora se
captura del propio `$inc` y se reusa. Capturarla no alcanzaba para no ESCRIBIR
(una comprobación previa no ve a quien entra mientras la escritura está en
vuelo), así que el upsert de `platformvideos` y el del espejo van guardados por
`linkVersion` / `link_version`.

### Paso 9 — outbox central

Todo lo anterior evita que una operación superada siga **destruyendo**. Lo que
no resuelve es lo que ya escribió antes de notarlo: una transición que alcanzó a
mover `files` y `backup_files` y ahí perdió deja esas dos representaciones en un
estado que nada repara -- el publish que la superó arregla `files`, que es lo
que le toca, pero nunca toca los badges de `backup_files`.

Y su registro queda `pending`. **Reprocesarla con la misma operación y el mismo
alcance congelado falla siempre igual**: su `baseVersion` describe un estado que
ya no existe. Por eso hay dos salidas, no una:

| Situación | Qué hace el worker |
|---|---|
| La operación sigue siendo dueña de la revisión vigente (se cortó por una caída) | La **reanuda**: sus escrituras son idempotentes y su alcance sigue valiendo |
| La superó otra operación | **Repara** las proyecciones hacia el estado canónico de AHORA y cierra como `superseded` |
| Fallo transitorio | Posterga con `nextAttemptAt` (espera creciente), suma `attempts`, registra `lastError` |
| Se agotaron los intentos | Cierra como `failed` |

`leaseOwner` es un **fencing token**, no una etiqueta: cerrar o liberar exige
presentarlo. `leaseUntil` solo no impide que un worker vencido termine encima
del nuevo -- los dos se creen dueños y gana el último en escribir.

La reparación **deriva** las proyecciones desde `FileModel` (la autoridad) en
vez de intentar deshacer operación por operación, que es lo único posible sin
transacciones y sin un log de undo. Todo va sellado con la revisión vigente, así
que la reparación tampoco puede pisar algo más nuevo.

### Verificación

50 tests en verde (45 integrales + 5 de convergencia), 0 skips, exit 0. `tsc`
backend 22 / local-backend 46. local-backend 2/2.

Tres cosas que encontró la batería de mutación y no la lectura:

- El caso de P6-2 tenía **la premisa falsa**: el archivo ya estaba confirmado,
  así que el publish no incrementaba nada y no tenía revisión propia que sellar.
- Su **punto de intercalado estaba después de todas las lecturas** del publish,
  así que no distinguía "usé la revisión que gané" de "la releí".
- Al caso del lease le faltaba afirmar que **un lease vigente no se puede
  robar**: solo comprobaba que el vencido no pudiera cerrar.

Y una del propio worker: parchear la función exportada `reproyectarPlataforma`
no alcanza a la llamada interna (bindings ESM), así que el caso del fallo
transitorio pasaba sin haber fallado nunca. Se fuerza el fallo en la escritura
real.

---

## Entrega 2e — cerrar el worker antes de cablearlo (4 casos nuevos)

### 1. El worker podía tomar una operación viva

La request registra la operación como `pending` y recién después hace el CAS que
escribe el claim. Entre esas dos cosas la operación **existe, está viva y no
tiene claim** -- que es exactamente el estado que el worker interpreta como "la
superaron". Si el worker corre ahí, la cierra como `superseded`; la request
sigue, gana el CAS, aplica la mitad y se cae: queda una transición parcial con
estado **terminal**, que ya nadie repara.

La solución no es que el worker espere a las operaciones nuevas -- eso es una
mitigación y una request lenta la sigue perdiendo. Request y worker usan ahora
el **mismo protocolo de lease**, y el cierre de `applyPlatformTransition`
también exige su `leaseOwner`.

**La regla del lease costó tres intentos**, y las dos primeras versiones estaban
mal en direcciones opuestas:

| Regla | Qué rompía |
|---|---|
| Tomarlo siempre, sin disputa | El perdedor del CAS escribía su token después del ganador; el ganador -- que sí aplicó todo -- no podía cerrar. Quedaba `pending` estando completa |
| Exigirlo siempre libre | El lease de un proceso muerto sigue vigente hasta vencer, así que una reanudación legítima esperaba ese vencimiento para hacer algo que ya podía hacer |
| **Sin disputa solo con prueba de propiedad** | Ganar el CAS, o `reanudando` (el claim de `files` dice que esta operación es dueña de la revisión vigente). Sin prueba: solo si nadie lo tiene vigente, y no conseguirlo no detiene la aplicación -- solo significa que esta entrega no es quien cierra |

La segunda versión fue la que hizo fallar **7 casos** que ya estaban en verde, y
la primera produjo un fallo que solo aparecía en la corrida completa y no
aislado.

### 2. La reparación no arreglaba el estado negativo

`reproyectarPlataforma` sabía llevar los badges al estado canónico, pero solo
sabía decir "esto está vinculado". Con el estado canónico en `unlink`/`discard`
dejaba **vínculos zombis en tres representaciones**: no desvinculaba
`platformvideos`, no dejaba tombstone en el espejo (solo marcaba `linked` los
que encontraba) y no retiraba el `platformLink` de Nube. Esos zombis son
justamente los que el próximo pull vuelve a convertir en links visibles en todas
las PCs.

Y para saber **qué ids** limpiar no alcanza con los vínculos vivos: si la
transición ya alcanzó a soltarlos, no queda ninguno que enumerar y el espejo se
queda diciendo `linked` para siempre. Los ids salen de la unión de tres fuentes:
el alcance congelado de la operación, los vínculos actuales y los espejos de ese
`content_id`.

### Los 4 casos

| Caso | Qué afirma |
|---|---|
| P8-1 | El worker no toma una operación que la request está aplicando |
| P8-2 | La reparación desvincula, deja tombstone y retira el link de Nube |
| P8-3 | Una request que perdió su lease no puede cerrar la operación |
| P8-4 | El tombstone se crea aunque ya no quede ningún vínculo vivo |

P8-3 y P8-4 nacieron de la batería de mutación: `cierre-sin-fencing` y
`ids-solo-de-vinculos` no rompían nada, porque el cierre de la request y la
unión de fuentes no los miraba ningún caso. Y `reserva-sin-lease` tampoco rompía
al principio -- el lease se escribe en dos lugares que se cubren mutuamente, así
que la mutación que vale muta los dos.

### Verificación

54 tests en verde (49 integrales + 5 de convergencia), 0 skips, exit 0, **tres
corridas completas seguidas** (una de las regresiones de esta ronda solo se veía
en la corrida completa). `tsc` backend 22 / local-backend 46. local-backend 2/2.

---

## Entrega 2f — el claim y el lease prueban cosas distintas

El worker adquiría su token `W`, llamaba a `applyPlatformTransition`, y esa
función generaba el suyo (`R`) y **reemplazaba `W` sin preguntar** -- porque
`reanudando` era tratado como prueba de propiedad. Si la reanudación fallaba, el
worker liberaba con `W`, que ya no era el vigente: no matcheaba nada, no quedaba
`lastError` ni `nextAttemptAt`, y la operación quedaba **trabada con un lease
sin dueño** hasta que venciera, sin registro de por qué.

El caso de fallo transitorio que ya existía solo cubría la rama
`superseded`/reproyectar. Esta era la otra rama.

La corrección es una distinción, no un parche:

| | Qué prueba |
|---|---|
| **Claim** (en `files`) | Que la operación sigue siendo causalmente **válida**: es dueña de la revisión vigente |
| **Lease** (en la operación) | Qué **ejecutor** puede trabajarla ahora |

`reanudando` prueba lo primero y no lo segundo. Ahora el worker **pasa su
token** a `applyPlatformTransition`, y una entrega HTTP -- que no trae token --
solo adquiere el lease si está libre o vencido; si lo tiene otro, responde
`202 in_progress`.

Consecuencia visible, y correcta: **un reintento inmediato después de una caída
recibe 202** hasta que el lease de la entrega anterior venza. Nadie puede
distinguir "ese proceso murió" de "está tardando" sin esperar. Tres casos que
asumían reanudación instantánea se actualizaron para afirmar las dos mitades: el
202 mientras el lease vale, y la reanudación después.

También se retiró el re-afirmado del lease post-CAS que había agregado la ronda
anterior: con esta regla solo llega al CAS quien ya tiene el lease, así que no
hay nada que re-afirmar -- y re-afirmarlo podía robárselo a un worker que lo
tomó porque este proceso se pasó de su vencimiento.

### Verificación

56 tests en verde, 0 skips, exit 0, tres corridas completas seguidas. `tsc`
backend 22 / local-backend 46. local-backend 2/2. Las 4 mutaciones de esta ronda
rompen cada una su caso -- dos de ellas contra el caso de reanudación exitosa,
no contra el de reanudación fallida.

---

## Entrega 2g — cableado del worker

| Punto | Cómo quedó |
|---|---|
| Arranque tras Mongo listo | En el `.then()` del `mongoose.connect`, con 10 s de retraso para no competir con el arranque. Antes de eso las consultas se encolarían en el buffer de Mongoose y el primer barrido correría a ciegas |
| Barrido periódico | Cada 5 min, `unref()` para no sostener el proceso |
| Sin pasadas solapadas en el proceso | Las pasadas se **encadenan** (no se descartan): quien pide una recibe la promesa de una que empieza después de la suya |
| Disparo oportunista | En el 202 `in_progress` del endpoint, fire-and-forget, con ventana de 30 s para que una ráfaga no dispare una pasada por operación |
| Backoff con jitter | Reparte sobre el 50% superior de la ventana |
| Métricas | `pendientes`, `fallidas` y **edad de la más vieja** |

**El barrido periódico no es opcional.** El caso que la reparación existe para
cubrir es justamente el que NO genera un evento después: el proceso se cayó a
mitad de una transición. Con disparo por evento nada más, esa última operación
espera a que alguien más haga algo -- que en una instalación de un solo usuario
puede ser al día siguiente. El oportunista es un adicional, no un sustituto.

**El jitter tampoco es cosmético.** Sin él, todo lo que falló junto -- que es lo
normal: una caída de Mongo tumba todas las operaciones en vuelo a la vez --
vuelve junto, falla junto y se reprograma junto. Una caída breve se convierte en
una tormenta periódica de reintentos sincronizados que se mantiene sola.

**Y las métricas miran lo que importa**: `pendientes` sube y baja solo, así que
por sí mismo no dice nada. Las dos señales son `fallidas` (nadie las reintenta:
si no las mira una persona, no existen) y la EDAD de la más vieja, que es lo que
distingue "hay cola" de "hay cola TRABADA".

### Dos casos que no probaban lo que decían

- El de solapamiento tenía **una sola operación** pendiente: el lease ya la
  serializaba, las otras pasadas no encontraban trabajo, y el guard del proceso
  quedaba sin ejercitar aunque no existiera. Con seis operaciones, sacar el
  encadenado rompe el caso.
- El techo del backoff estaba aplicado **dos veces** (antes y después del
  jitter), así que sacar uno no cambiaba nada -- no había forma de saber cuál
  sostenía el límite. Quedó uno solo, sobre el valor final.

### Verificación

59 tests en verde, 0 skips, exit 0, tres corridas completas seguidas. `tsc`
backend 22 / local-backend 46. local-backend 2/2.

---

## Entrega 3 — migración de `discard` (escritorio)

### El P1 de observabilidad, primero

`pasadaConReporte` volvía apenas `revisadas === 0`, **antes** de medir. Y ese es
exactamente el estado de una cola enferma: una `failed` no la toma nadie nunca,
y una pendiente esperando su backoff tampoco, así que todos los barridos dan
cero -- y la cola desaparecía de la vista justo cuando había algo para ver.
Ahora se mide siempre; lo que está limitado es el **log** (una ventana de 15
min), que es lo caro, no la medición.

### El descarte

`updateVideoPlatforms` escribía `platforms_discarded` en SQLite y confiaba en
que el push del catálogo lo llevara: un badge dentro de un array dentro de un
push masivo. **Sin `operationId`** (un reintento era una operación nueva), **sin
`baseVersion`** (sin precedencia causal) y **sin nada que lo reintentara** si el
push fallaba. La misma familia de bugs que motivó todo esto, en la otra acción.

Ahora pasa por la misma maquinaria que el unlink: se encola dentro de la
**misma `db.transaction()`** que el cambio local, y se entrega después del
commit.

Un detalle que sí es propio del descarte: se encola **por el cambio, no por el
estado**. `updateVideoPlatforms` recibe el array completo de descartadas, así
que encolar lo que llega generaría una operación por cada guardado -- un
re-render, un doble clic -- cada una con su propia `baseVersion`, y todas menos
la primera nacidas destinadas al conflicto. Solo se encolan las plataformas que
*pasan* a descartadas.

### Contrato verificado para el escritorio

| Punto | Dónde |
|---|---|
| `operationId` estable entre reintentos | P12-2 (dos flushes fallidos, mismo id y misma base) |
| `baseVersion` obtenida junto con el estado | P3 + P6-1 (viaja dentro de `GET /api/backup/files`) |
| `200 + version` = entregada | P4-b |
| `202` sigue pendiente | P4-a |
| `409` refresca y no reintenta a ciegas | OUT-4 (guarda la revisión vigente y archiva) |
| `422` terminal | flush: 4xx no-auth/no-rate-limit → `failed` |
| Intención persistida antes del cambio local | P12-3 (si no se puede encolar, el badge no cambia) |

El `DELETE` legado sigue en pie: se retira cuando no queden clientes viejos.

### Verificación

64 tests en verde, 0 skips, exit 0, tres corridas completas seguidas. `tsc`
backend 22 / local-backend 46. local-backend 2/2.

Dos casos que no probaban lo que decían, otra vez destapados por la mutación:

- El de observabilidad llamaba a `observarCola` **a mano**, así que probaba que
  la medición funciona -- no que alguien la esté llamando, que era justo lo que
  fallaba. Ahora pasa por `pasadaDeMantenimiento`, el camino real del arranque,
  el barrido y el disparo oportunista.
- Faltaba el caso de repetir el mismo descarte, así que "encolar por estado" en
  vez de "por cambio" no rompía nada.

### Lo que la outbox todavía NO cubre

- Solo el **unlink desde Electron** pasa por acá. `discard`, iOS y Android
  siguen usando el `DELETE` viejo, sin `operationId` ni `baseVersion`. No se
  migran todavía a propósito: hacerlo sobre el contrato anterior solo habría
  multiplicado las operaciones expuestas a estas mismas ventanas.
- El worker de reparación existe y está probado, pero **nada lo dispara
  todavía**. Cablearlo pide: corrida al arrancar (después de que Mongo esté
  listo), barrido periódico (un trigger por eventos no recupera la última
  operación si el proceso cayó), protección contra pasadas solapadas dentro del
  proceso -- el lease cubre las réplicas --, disparo oportunista tras detectar
  una pendiente sin bloquear la respuesta HTTP, backoff con jitter, y métricas
  de `pending`, `failed` y edad máxima.
- Siguen faltando los **5 callers** del paso 1.3.
