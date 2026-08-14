# Revisión independiente MongoDB — 2026-08-13

Revisión de solo lectura del plan `docs/mongo-remediation-plan-2026-08-13.md`
(Fix 5 y Fix 6), siguiendo el protocolo de
`docs/mongo-remediation-review-plan.md`. Corrida por un subagente aislado sin
acceso de escritura a Mongo ni al código.

## Veredicto

**bloqueado**

Motivo formal: de las 5 preguntas obligatorias del protocolo se pueden
responder 4 con evidencia, pero **no hay ninguna prueba de cliente**
(Electron/iOS/Android/usuario free) y la producción tiene datos de un solo
`userId` de 17 — el invariante multiusuario que Fix 5 dice proteger no es
verificable empíricamente hoy.

Motivo técnico: Fix 5 tal como estaba escrito **no arregla el problema de
identidad que dice arreglar** y agrega un modo de falla nuevo sobre el push
de backup (ver H7, H8). Fix 6 tiene una de sus dos acciones basada en un
supuesto falso (S1) y no debe ejecutarse tal cual.

## Hallazgos confirmados (resumen — ver detalle completo abajo)

- **H1** — Fix 1 y Fix 2 (ya aplicados) quedaron bien. Sin observaciones.
- **H2** — `files.file_path` único global **ya colisiona hoy**: 55 documentos
  con `file_path = file_name` (placeholder de backup). Cualquier usuario
  free puede insertar en `files` vía `/api/sync/history` (sin gate de plan)
  → primer nombre de archivo repetido entre cuentas = 500 en bucle.
- **H3** — El índice sparse compuesto actual (`userId_1_content_id_1`) no
  protege nada: en Mongo un sparse compuesto indexa igual si falta *una*
  clave. El índice partial nuevo necesita **otro nombre**, no reemplazar al
  sparse en el lugar.
- **H4** — `autoIndex` de mongoose sigue activo; el cambio de índice y el
  cambio del modelo tienen que ir en el mismo deploy o mongoose recrea el
  índice viejo solo.
- **H7** — `bulkUpsertBackupFiles` hace `bulkWrite` **ordered**, sin
  try/catch por operación. Con un índice único nuevo, **un solo duplicado
  tira 500 y aborta todo el backup** (transcripciones, platform_videos,
  config, reconciliación — todo lo que va después en la misma request).
- **H8** — `content_id` no es identidad estable: `resolveOrCreateFile` nunca
  lo setea al crear, y `bulkUpsertBackupFiles` lo **sobreescribe** cuando el
  doc se matcheó por nombre. Poner un índice único sobre un campo que el
  propio escritor reasigna es la falla central del Fix 5 tal como estaba.
- **H9** — El fallback por nombre de `resolveOrCreateFile` puede atribuir
  una publicación al archivo equivocado (dos videos con mismo nombre, mismo
  usuario) — el índice único propuesto no lo evita, solo lo hace fallar más
  tarde y más ruidoso.
- **H11** — `applyPlatformPublish` NO es el único escritor efectivo: hay 7
  puntos más que escriben `platforms`/`platformLinks` directo (uploaders de
  Instagram/YouTube/TikTok, `bulkUpsertBackupFiles`, `updateFilePlatforms`,
  `unlinkPlatform`, `updateRemoteLibraryVideoPlatforms`).
- **H12** — La guarda anti-resurrección de link manual depende del match por
  `fileName`, no de `contentId` (solo 29/138 eventos de historial tienen
  `contentId`). No degradar ese camino.

## Supuestos incorrectos del plan original

- **S1 — el "archivo con >3 resoluciones" NO es un dato corrupto.**
  `facebook` es un destino legítimo de crossposting que escribe el flujo de
  Instagram. El bug real es que el enum de Mongoose (`file.model.ts`) no
  incluye `'facebook'` — "reparar" el documento a mano borraría una
  publicación real que se recrearía sola en la próxima subida. Sacar esta
  acción del Fix 6; el arreglo correcto es agregar `facebook` al enum.
- **S2** — La fila "Documentos sin userId: 0" de la auditoría es inexacta:
  `transcripts` tiene 1,094 documentos sin `userId` (scopeados
  transitivamente por `file_id`, no es un hueco de seguridad, pero la
  afirmación tal cual está escrita es falsa).
- **S4** — El plan diagnosticó el riesgo de identidad en el lugar
  equivocado: los clientes (Electron/iOS/Android) sí priorizan `content_id`
  correctamente. El problema está en la central (`resolveOrCreateFile`,
  `bulkUpsertBackupFiles`).

## Plan de migración validado por el revisor (para cuando se retome)

**Fase 0 (bloqueante, código, antes de tocar cualquier índice):**
- C1: `bulkWrite` de `files`/`backup_files` a `{ordered:false}` + captura de
  `BulkWriteError` (que un duplicado no tumbe todo el backup).
- C2: `resolveOrCreateFile` debe setear `content_id` al crear.
- C3: `bulkUpsertBackupFiles` no debe reasignar `content_id` de un doc
  matcheado por nombre.
- C4: decidir precedencia entre `(userId,file_name)` único (ya existe en
  `backup_files`) y el nuevo `(userId,content_id)` único, para el caso de
  rename local.
- C5: migración de índice + cambio de modelo en el mismo deploy.

**Fase 3 — SÍ tiene una parte de bajo riesgo, ejecutable ya:** crear
`files` único `{userId,file_path}` ANTES de dropear el `file_path_1` global
(0 duplicados hoy, aditivo, resuelve H2 que es un bug activo real).

**Fase 4 — `content_id` único parcial:** NO aprobada hasta C1-C3 + pruebas
de cliente reales.

**Fase 5 — Fix 6 reducido:** solo normalizar los 19 documentos con arrays
ausentes (`$set: {platforms:[]}` / `{platforms_discarded:[]}`), por driver
crudo para no bumpear `updatedAt` (afecta el pull de Electron). Sin tocar el
archivo de `facebook` (ver S1).

**Fase 6 — Postflight:** pruebas de cliente reales (Electron push/wipe/pull,
iOS/Android con y sin `contentId`, dos cuentas con mismo `fileName` +
`platformId`, usuario free, link manual corregido tras varios ticks). Es la
condición de desbloqueo — hoy no existe ninguna.

## Rollback

Igual que el documentado en el plan para los índices nuevos (`dropIndex` por
nombre); la Fase 5 (normalización) no tiene rollback por índice — hay que
guardar la lista de `_id` afectados en el preflight para poder revertir.

## Notas menores fuera de foco (sin acción requerida ahora)

`sync.controller.ts` hace `FileModel.findById(fileId)` sin `userId` en dos
lugares (lee `file_name` de un archivo ajeno si se pasa un id de otro
usuario, aunque la escritura posterior sí queda scopeada). Mismo patrón en
los 3 uploaders (`findByIdAndUpdate(fileId, …)` sin `userId`). No es el foco
de esta revisión: candidato a un ticket aparte.
