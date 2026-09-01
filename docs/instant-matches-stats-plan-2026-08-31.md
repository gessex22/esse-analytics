# Plan: invalidación instantánea de Matches/Estadísticas (2026-08-31)

Objetivo: que una publicación aparezca en "Matches" en pocos segundos y
que, al completar el último enlace, aparezca inmediatamente en
"Estadísticas comparadas". Plan del usuario, documentado tal cual antes de
empezar a implementar nada.

> **Dependencia explícita con SYNC-02 #1** (ver `docs/SYNC-01-audit-2026-08-30.md`):
> este plan construye una capa reactiva sobre la identidad de archivo
> (`content_id`/`fileId`). Con la divergencia histórica encontrada el
> 2026-08-31 (1034 registros con `content_id` distinto entre `files` y
> `backup_files`, causa raíz confirmada: wipe del 2026-06-26) todavía sin
> reconciliar, cualquier evento cross-device de este plan (`publication.linked`,
> `cross_match.completed`) que dependa de matchear por `fileId`/`content_id`
> puede resolver mal para esos 1034 registros -- heredaría el mismo
> split-brain en vez de arreglarlo. El propio plan original lo señala en su
> resumen: la Fase 7 (esto) va DESPUÉS de consolidar la identidad, no en
> paralelo.

## 1. Instrumentar y reproducir

Registrar timestamps para medir cada tramo:
`publicación confirmada → Mongo actualizado → Electron notificado → Matches refrescado → match completado → Estadísticas refrescadas`

Esto permite distinguir retrasos de Instagram, backend, sincronización y UI.

## 2. Corregir la elegibilidad de "Matches"

Revisar la consulta actual (`sync.controller.ts`), que exige que
`FileModel.platforms` contenga las tres plataformas. El candidato debería
aparecer desde que exista al menos una publicación real vinculada,
mostrando las plataformas restantes como pendientes.

Archivo principal: `backend/src/controllers/sync.controller.ts`.

## 3. Invalidación inmediata dentro del mismo dispositivo

Crear un servicio central de eventos del frontend:
- `publication-updated`
- `match-updated`
- `stats-invalidated`

Después de publicar: invalidar y recargar "Matches", sin esperar el
cooldown de 5 minutos.

Después de completar un enlace: actualizar el candidato localmente, limpiar
`statsCache`, recargar "Estadísticas" si está abierta.

Archivos principales:
- `frontend/src/components/SyncPanel.tsx`
- `frontend/src/components/StatsView.tsx`
- Controladores de publicación de Instagram, YouTube y TikTok.

## 4. Notificación cross-device

Canal de eventos autenticado entre el backend central y Electron,
preferiblemente SSE:
- `publication.created`
- `publication.linked`
- `cross_match.completed`

Cada evento incluye `userId`, `fileId`, plataforma y una revisión
monotónica. Electron solo procesa eventos del usuario autenticado.

Al recibirlos:
- `publication.created` refresca "Matches".
- `publication.linked` actualiza el slot correspondiente.
- `cross_match.completed` invalida "Estadísticas".

Reconexión automática + polling de respaldo cada 30-60s para recuperar
eventos perdidos.

## 5. Separar caché estructural de caché de métricas

Hoy un match nuevo guarda `lastSyncedAt`, haciendo que estadísticas
todavía vacías se consideren frescas durante 5 minutos.

Cambios:
- Crear `statsSyncedAt` (nuevo, separado de `lastSyncedAt`).
- `lastSyncedAt` sigue indicando sincronización del vínculo.
- Un match nuevo tiene `statsSyncedAt: null`.
- Primera consulta inmediata de métricas.
- Después, mantener la caché de 5 min (protege cuotas de las APIs).

El video debe aparecer inmediatamente aunque la plataforma todavía
devuelva cero métricas.

## 6. Refresco selectivo

No ejecutar `push + pull + preload` completo por cada evento. Refrescar
solo: candidatos de Matches, el archivo afectado, estadísticas del grupo
afectado.

El cooldown general de `frontend/src/services/syncOrchestrator.ts` sigue
protegiendo la sincronización completa, pero no debe bloquear estas
actualizaciones puntuales.

## 7. Pruebas

Casos mínimos:
1. Publicar en Instagram desde Electron.
2. Publicar desde iOS y observar Electron.
3. Publicar desde Android y observar Electron.
4. Mantener "Matches" abierto durante la publicación.
5. Completar el segundo y el tercer enlace.
6. Mantener "Estadísticas" abierta mientras se completa el match.
7. Cerrar y reabrir Electron.
8. Perder conexión durante un evento y reconectar.
9. Confirmar que no aparecen registros duplicados.
10. Confirmar que muchos eventos juntos producen un solo refresco (debounce).

### Criterios de aceptación

- Publicación visible en "Matches" en menos de 5s con conexión normal.
- Match completo visible en "Estadísticas" en menos de 2s.
- Ninguna espera causada por el cooldown general.
- Eventos perdidos recuperados por el polling de respaldo.
- Sin aumento descontrolado de llamadas a Instagram/TikTok/YouTube.

## Entregas propuestas por el usuario

1. Invalidación local (pasos 1-3, 5-6 parcial -- lo que no necesita SSE).
2. Eventos cross-device (paso 4).
3. Separación de caché de métricas (paso 5 completo).

## Estado

**Paso 5 (separar caché estructural de caché de métricas): IMPLEMENTADO
2026-08-31**, tras cerrar la reconciliación de `content_id` (SYNC-02#1).

- `platform-video.model.ts`: campo nuevo `statsSyncedAt?: Date | null`,
  default `null` (a diferencia de `lastSyncedAt`, que sigue con
  `default: Date.now`). `lastSyncedAt` no cambió de significado -- sigue
  siendo "sincronización del vínculo", usado para desempatar entre 2
  documentos de la misma plataforma en `buildFilePlatforms`.
- `sync.controller.ts::buildFilePlatforms`: la verificación de vencimiento
  de caché (`statsCacheWindowMs`) pasa a leer `statsSyncedAt` en vez de
  `lastSyncedAt`. `null` (match recién creado, nunca se pidieron métricas
  reales) cuenta como vencido de entrada -- sin esperar los 5 minutos.
- `resolveCrossMatchSlot` (el endpoint real de "Matches" en
  `SyncPanel.tsx`): `statsSyncedAt: null` explícito en el `$set` -- las
  `stats` que manda el cliente ahí pueden venir de una lista cacheada, no
  de un fetch en vivo de ese instante, y además puede ser un re-match a un
  platformId distinto del anterior. No hay que confiar en que sean
  "frescas" solo porque se acaban de guardar.
- `applyPlatformPublish` (el camino principal de "esto se publicó de
  verdad"): **sin cambios necesarios** -- ya usa `findOneAndUpdate` con
  `upsert:true` sin tocar `statsSyncedAt` en el `$set`, así que Mongoose
  aplica el default (`null`) solo en el INSERT real (confirmado:
  `setDefaultsOnInsert` no está deshabilitado en ningún lado de este
  proyecto) y preserva el valor existente en un update/retry idempotente.
- Los dos bulkOps que sí hacen un fetch real a la API de la plataforma
  (`getGroupStats` y `getFileStats`, tras `getYoutubeVideoStats`/
  `getMediaStats`/`getTiktokVideoStats`) ahora también escriben
  `statsSyncedAt: new Date()`, además del `lastSyncedAt` que ya escribían.

Verificado con `tsc --noEmit`: 27 errores totales, los mismos de antes de
tocar nada (confirmado línea por línea que ninguno de los nuevos está en
el código agregado -- son preexistentes en otras funciones, solo se
corrieron de línea por las inserciones).

**No implementado todavía**: "hacer una primera consulta inmediata de
métricas" apenas se crea el match (el resto del Paso 5) -- el efecto
práctico ya está cubierto porque el primer `getGroupStats`/`getFileStats`
real que el usuario dispare (que suele pasar en segundos, al abrir/
refrescar Estadísticas) ahora SÍ hace el fetch en vivo en vez de servir
0 cacheado por 5 minutos. Agregar un fetch proactivo en el momento mismo
de publicar quedaría como optimización aparte si hiciera falta.

**Pasos 1-4, 6-7: sin empezar.** Paso 2 (elegibilidad de Matches por
`FileModel.platforms`) es un cambio distinto y acotado, no tocado en esta
pasada. Pasos 3-4 (invalidación local + eventos cross-device) siguen
pendientes de decisión de arranque.

## Paso 2 — implementado y rediseñado (2026-09-01)

Sesión 2026-09-01: elegibilidad de "Matches" (`getCrossMatchCandidates`,
`sync.controller.ts`) pasó de exigir las 3 badges (`$all`) a aceptar
`minPlatforms` (1 = cualquier actividad, "todos"). Aplicado en Electron
(`SyncPanel.tsx`) e iOS (`SyncView.swift`, mismo endpoint) el mismo día.

**Rediseño posterior, mismo día** (usuario reportó que el filtro "abruma"
y que un video con 2 confirmadas + 1 descartada nunca se veía como
completo): "resuelto" ahora cuenta `platforms_discarded` como decidido,
no solo `platforms` publicado. Filtro bajó de 3 opciones (Todos/2+/3) a 2
(Todos/Resuelto). Nuevo estado visual "Descartado" en el chip por
plataforma (no clickeable) en vez de invitar a "buscar match" para algo
ya decidido. Backend usa `$expr`+`$setIsSubset` sobre la unión de
`platforms`+`platforms_discarded` para "Resuelto". Mismo cambio en
Electron y iOS. Ver `docs/bug-reports.md` para el detalle completo y
[[mobile_audit_2026_08_30_refresh_sync_thumbs]] para el hilo completo de
esta sesión (incluye 2 bugs más encontrados de paso: Calendario iOS sin
refresh-trigger, Dashboard "Pendiente de datos" en plataforma
descartada).

**Bug encontrado en el camino (2026-09-01, ya corregido)**: `resolved`/
`discarded` sin optional chaining en el frontend crasheaba toda la vista
de Sync (sin error boundary en la app) si la central que responde es un
proceso viejo sin reiniciar y no manda el campo nuevo — la central corre
aparte de Electron, instalar el `.exe` nuevo no la actualiza. Lección:
cualquier campo nuevo en una respuesta de API debe leerse con `?.`/default
en el cliente, nunca asumir que el backend que responde ya tiene el
código nuevo.

Pasos 1, 3, 4, 6, 7 siguen sin empezar.
