# Plan de revisión independiente — Correcciones MongoDB

## Objetivo

Validar o rechazar el plan de corrección de
`docs/mongo-audit-2026-08-13.md` antes de ejecutar migraciones, eliminar
índices o modificar documentos. Esta revisión es de **solo lectura**: no debe
escribir en Mongo, cambiar código ni desplegar nada.

## Material de entrada

1. `docs/mongo-audit-2026-08-13.md`
2. El plan de corrección derivado de esa auditoría.
3. Modelos en `backend/src/models/`.
4. Flujos de publicación y recuperación en:
   - `backend/src/controllers/backup.controller.ts`
   - `backend/src/controllers/sync.controller.ts`
   - `backend/src/controllers/remote-library.controller.ts`
   - `local-backend/src/controllers/backup-sync.controller.ts`
   - `local-backend/src/services/upload-history.service.ts`

## Invariantes que el revisor debe proteger

- Un usuario solo puede leer o mutar sus propios documentos.
- Un link manual existente nunca se sustituye por un match inferido.
- `platforms` y `platforms_discarded` no se sobrescriben durante migraciones.
- Una publicación confirmada conserva plataforma, ID nativo, URL y fecha.
- El pull de Electron puede reconstruir enlaces y badges después de un wipe.
- Los usuarios free no obtienen acceso accidental a Biblioteca remota ni pierden
  su catálogo de metadata.
- Las cuentas con el mismo nombre de archivo o el mismo ID de plataforma no
  interfieren entre sí.

## Secuencia de revisión

### 1. Inventario y semántica

Para cada colección, documentar:

- Fuente de verdad, espejo o cache derivada.
- Quién escribe y quién lee.
- Clave de identidad y clave de aislamiento por usuario.
- Si es necesaria para usuarios free, premium, owner o para todos.
- Política de retención/borrado.

Confirmar en particular que:

- `audit_events` es el log append-only.
- `upload_history` es una proyección idempotente por publicación, no un log
  inmutable.
- `files.platforms` representa el estado de resolución; `platformvideos` y
  `backup_platform_videos` representan enlaces y metadatos de plataforma.
- `publishing_status` es legacy y no una fuente activa de UI.

### 2. Índices P0

Revisar con `getIndexes()` y consultas de agregación de solo lectura:

1. `platformvideos`
   - Confirmar la presencia de ambos índices únicos:
     `{ userId, platform, platformId }` y `{ platform, platformId }`.
   - Confirmar que las queries y upserts del código usan la clave con `userId`.
   - Anotar que la ausencia de colisiones cross-user es esperable: el índice
     legado global las bloquea actualmente.
2. `platform_config`
   - Comprobar duplicados por `{ userId, platform }`.
   - Identificar todos los `updateOne(..., { upsert: true })` que dependen de
     esa unicidad.

Resultado esperado: recomendar o rechazar la eliminación del índice global de
`platformvideos` y la creación del índice único de `platform_config`.

### 3. Identidad de archivos

Revisar `files`, `backup_files` y `remote_library_videos`:

- Confirmar ausencia de duplicados actuales por `(userId, content_id)`.
- Revisar cómo se comportan documentos sin `content_id` o con `content_id: null`.
- Confirmar que los clientes usan `contentId` primero y `fileName` solo como
  fallback.
- Revisar el índice global actual de `files.file_path` y los paths placeholder
  creados desde el backup.
- Identificar cualquier query que aún trate `file_path` como identidad global.

El revisor debe especificar el índice exacto recomendado. Si usa `content_id`,
debe ser único parcial por valor string, por ejemplo:

```js
{ unique: true, partialFilterExpression: { content_id: { $type: "string" } } }
```

No aprobar un índice único simple que incluya los `null` legacy.

### 4. Estado de publicación y enlaces manuales

Comparar para una muestra y para conteos globales:

- `files.platforms` y `files.platforms_discarded`.
- `platformvideos.linkedFileId`, `platformId` y `platformUrl`.
- `backup_platform_videos`.
- `publishing_status`.
- `remote_library_videos.platforms` y `platformLinks`.

Validar específicamente estos escenarios:

1. Link manual corregido: el ID viejo no puede resucitar en el siguiente pull.
2. Publicación desde iOS/Android: debe aparecer en historial, calendario y
   pull de Electron.
3. Publicación desde Electron: debe reflejar badge y enlace en central.
4. Video en Biblioteca remota: agregar un `platformLink` solo si el match es
   inequívoco; nunca reemplazar uno existente.
5. Video descartado: conservar el descarte aunque otro dispositivo sincronice.

El revisor debe comprobar que `applyPlatformPublish()` no es el único escritor
efectivo de cada representación y listar las excepciones.

### 5. Usuarios y permisos

Revisar cada ruta que lea/escriba las colecciones afectadas:

- Todas deben filtrar por `req.user.id`/`userId`.
- Las rutas de Biblioteca remota deben seguir usando el gate de owner o cloud
  storage; un índice/migración no debe crear registros remotos para un usuario
  free.
- Verificar que dos usuarios con mismo `fileName` y un mismo `platformId` no
  pueden cruzar enlaces, badges ni historial.

### 6. Validación del plan de migración

El revisor debe proponer una versión final con estas fases:

1. Preflight de solo lectura, con conteos guardados.
2. Backup/export o snapshot antes de cada cambio de índice.
3. Cambios de índices aislados y reversibles.
4. Normalización mínima (`null → []`) sin inferir publicaciones.
5. Backfill estrictamente aditivo de `platformLinks`, primero por `contentId`;
   por nombre únicamente cuando haya un candidato único.
6. Postflight con las mismas consultas y pruebas de clientes.

## Criterios para aprobar una ejecución

Solo se puede aprobar si el informe final responde explícitamente:

- ¿Qué índice se elimina/crea, con nombre y spec exactos?
- ¿Qué documentos se modificarían y por qué?
- ¿Qué flujo de publicación, link manual o pull podría verse afectado?
- ¿Cómo se revierte cada paso?
- ¿Qué pruebas se hicieron para Electron, iOS, Android y usuario free?

Si falta cualquiera de esas respuestas, el resultado debe ser **bloqueado**,
no “aprobado con reservas”.

## Formato de entrega del revisor

```md
# Revisión independiente MongoDB — YYYY-MM-DD

## Veredicto
aprobado | aprobado con cambios | bloqueado

## Hallazgos confirmados

## Supuestos incorrectos o incompletos

## Riesgos por flujo
- Link manual:
- iOS/Android:
- Electron pull:
- Usuario free:
- Biblioteca remota:

## Plan de migración validado

## Rollback

## Evidencia
- Consultas de solo lectura:
- Índices observados:
- Pruebas de clientes:
```
