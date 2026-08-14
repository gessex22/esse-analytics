# Plan de corrección — Auditoría MongoDB 2026-08-13

Plan derivado de `docs/mongo-audit-2026-08-13.md`, para ser validado según el
protocolo de `docs/mongo-remediation-review-plan.md` antes de ejecutar lo que
falta. Ver la tabla "Estado de remediación" al principio del documento de
auditoría para el estado más al día — este archivo es el detalle de cada fix,
tanto los ya aplicados como los pendientes.

## Ya aplicado (2026-08-13, no requiere re-validación salvo que el revisor
encuentre algo mal)

### Fix 1 — Índice legado en `platformvideos` (P0) ✅ aplicado

Eliminado `platform_1_platformId_1` (único, `{platform,platformId}`) que
convivía con el correcto `userId_1_platform_1_platformId_1`. Preflight:
0 combinaciones `platform+platformId` compartidas entre distintos `userId`.
Rollback: `db.platformvideos.createIndex({platform:1,platformId:1},{unique:true,name:"platform_1_platformId_1"})`.

### Fix 2 — Índice único faltante en `platform_config` (P0) ✅ aplicado

Creado `userId_1_platform_1` (único, `{userId:1,platform:1}`). Preflight:
0 duplicados por `(userId,platform)`. Rollback:
`db.platform_config.dropIndex("userId_1_platform_1")`.

Script usado para ambos: `backend/scripts/mongo-p0-index-fixes.js`
(dry-run/--apply, imprime preflight/postflight y rollback exacto).

### Fix 4 — Deprecar `publishing_status` (P1) ✅ aplicado (pasos 1-3 de 4)

- Sacados `getPublishingStatus`/`updatePublishingStatus` y el tipo
  `PublishingStatus` de `frontend/src/services/api.ts` (0 callers
  confirmados en toda la UI).
- Rutas/controllers/modelo marcados `LEGACY` (comentario) en central y
  local-backend, sin borrar código ni colección todavía.
- Eliminado `local-backend/src/models/publishing-status.model.ts` (modelo
  mongoose huérfano, nunca importado, local-backend no tiene `mongoose`
  como dependencia).
- **Paso 4 (no aplicado, no urgente):** borrar ruta/modelo/colección de
  verdad una vez que pase un tiempo prudencial sin uso.

### Reclasificado, no es un fix — `platformLinks` ausente en 1,092 videos remotos (P1)

Confirmado en código (`remote-library.controller.ts`): `platformLinks` solo
se llena vía `updateRemoteLibraryVideoPlatforms`, sin backfill automático.
Son registros históricos nunca matcheados a mano, no una regresión activa.
No se ejecuta ningún fix salvo que el revisor encuentre lo contrario.

## Pendiente de validar y ejecutar

### Fix 5 — Identidad de archivo no consolidada (P1, riesgo medio)

**Problema:** `content_id` se usa como identidad estable de `files` para
resolver renombres, pero no hay índice único que lo garantice (ni en `files`
ni en `backup_files`). Además `files.file_path` es único **global**; el flujo
de backup crea filas centrales con `file_path = file_name` como placeholder,
así que dos usuarios con el mismo nombre de archivo (ej. `render.mp4`)
pueden colisionar.

**Datos de la auditoría (2026-08-13):** 0 duplicados actuales por
`(userId, content_id)` en `files` y en `backup_files`.

**Propuesta:**
1. Crear índice único **parcial** en `files` y `backup_files`:
   ```js
   db.files.createIndex(
     { userId: 1, content_id: 1 },
     { unique: true, partialFilterExpression: { content_id: { $type: "string" } } }
   )
   ```
   (mismo criterio en `backup_files`). El filtro parcial excluye documentos
   con `content_id` nulo/ausente/no-string — un índice único simple
   rompería con los legacy nulos.
2. `files.file_path`: pasar de único-global a único-compuesto
   `{userId:1, file_path:1}`, o dejar de depender del placeholder de nombre
   como identidad (evaluar cuál según lo que encuentre el revisor sobre los
   paths placeholder del backup).

**Riesgo:** medio — toca un índice que hoy previene colisiones reales entre
archivos del mismo usuario; requiere confirmar que los clientes (Electron,
iOS, Android) usan `content_id` como identidad primaria y `file_name` solo
como fallback antes de aplicar, y validar los escenarios de link manual /
pull / usuario free del protocolo de revisión.

### Fix 6 — Normalización de campos legacy (P2, riesgo bajo)

- 6 `files.platforms` nulos/no-array, 13 `files.platforms_discarded`
  nulos/no-array → normalizar a `[]`.
- 1 archivo con más de 3 resoluciones de plataforma (dato corrupto o
  legado) → aislar y reparar a mano, no en bulk.
- Confirmar que las agregaciones que ya no dependan de arrays presentes
  usan `$ifNull`.

**Riesgo:** bajo, son writes puntuales sobre pocos documentos, ninguno
toca índices ni identidad.

## Qué necesita el revisor para aprobar

Seguir exactamente `docs/mongo-remediation-review-plan.md` — en particular
la sección 3 (Identidad de archivos) y 6 (Validación del plan de migración)
aplican de lleno a Fix 5; la sección 4 (Estado de publicación) ya no aplica
a `publishing_status` en sí (deprecado) pero sigue aplicando a la
consistencia entre `files.platforms`/`platformvideos`/`backup_platform_videos`.
