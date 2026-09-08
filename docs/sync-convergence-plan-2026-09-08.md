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

El del medio corre contra un Mongo local descartable (Docker). Si no hay
ninguno escuchando **se saltea, no falla**: "no hay Mongo" nunca debe leerse
igual que "el bug se arregló".

**Pendiente de rediseño (ver "Riesgos" abajo): el test del pull** hardcodea la
respuesta de la nube en su estado *buggy*. Cuando el escritor único aterrice,
la nube ya no va a producir ese estado, así que el test seguiría rojo aunque el
bug esté arreglado. Hay que reemplazarlo por un ciclo completo push→pull real
usando el Mongo de Docker.

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

## Estado

| Entrega | Estado |
|---|---|
| 1.1 tests rojos | Hecho (3 rojos, rama `test/sync-convergence-red`) |
| 1.2 servicio central | En curso |
| 1.3 rutear escritores | Sin empezar |
| 1.4 propagar el error | Sin empezar |
| 2 a 5 | Sin empezar |
