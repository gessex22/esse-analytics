# Handoff — Auditoría MongoDB + diseño de instalación primaria (2026-08-13/14)

Punto de entrada único para retomar este trabajo sin releer la conversación
completa. Escrito para un agente que arranca en frío.

## Orden de lectura recomendado

1. Este documento (estado general, qué hacer después).
2. `docs/mongo-audit-2026-08-13.md` — auditoría original + tabla "Estado de
   remediación" (la fuente de verdad de qué está aplicado). El cuerpo de
   abajo de ese doc es la auditoría *sin actualizar*, tiene una nota al
   principio explicándolo — no confiar en esa parte sin cruzarla con la
   tabla de arriba.
3. `docs/mongo-remediation-plan-2026-08-13.md` — detalle de cada fix
   propuesto (aplicados y pendientes).
4. `docs/mongo-remediation-review-2026-08-13.md` — revisión independiente
   (protocolo: `docs/mongo-remediation-review-plan.md`), veredicto
   **bloqueado**, hallazgos H1-H12.
5. `docs/single-primary-install-plan-2026-08-14.md` — diseño alternativo
   para desbloquear el índice de `content_id`, con decisión final tomada
   (Opción A + subida simple ad-hoc), sin implementar todavía.
6. `docs/primary-install-implementation-plan-2026-08-14.md` — **el plan de
   ejecución real, fase por fase, para lo decidido en el doc anterior.**
   Ya pasó una revisión y tiene una corrección de contrato aplicada
   (`resolveOrCreateFile`). Es el documento a seguir si se va a implementar
   esto. Incluye 2 hallazgos de seguridad reales y no relacionados con
   `content_id` (ver siguiente sección) que son prioridad inmediata.
7. `docs/primary-install-installid-lifecycle-blocker-2026-08-14.md` — cadena
   de evidencia del bloqueante (`installId` no sobrevive un logout normal).
   Resuelto en diseño, ver siguiente punto.
8. `docs/primary-install-corrected-plan-2026-08-14.md` — **el plan vigente
   a seguir para la instalación primaria, reemplaza las Fases 0-1 de
   `primary-install-implementation-plan-2026-08-14.md`.** `device_id`
   (nuevo, sobrevive logout) separado de `install_id` (existente, sigue
   siendo solo para autorizar operaciones destructivas). Incluye la
   resolución del bootstrap (auto-claim silencioso en el primer uso, sin
   contraseña — la contraseña solo se exige para *reemplazar* una primaria
   ya establecida). Sin implementar todavía — hay que migrar lo pusheado en
   `6608423`/`2614645`, no tirarlo.

## Qué se hizo y ya está en producción/main

Todo commiteado y pusheado a `main` (`gessex22/esse-analytics`), en orden:

| Commit | Qué |
| --- | --- |
| `bb292f4` | Checkpoint de trabajo previo sin relación (frontend WIP, etc.) |
| `a0d9840` | Fix P0: eliminado índice legado `platformvideos.platform_1_platformId_1`, creado único `platform_config.userId_1_platform_1`. Script `mongo-p0-index-fixes.js`. |
| `06698ff` | Deprecado `publishing_status` (sin callers en frontend) |
| `40a9d7d` | Plan de corrección escrito para revisión independiente |
| `f82e96f` | Revisión independiente ejecutada — veredicto bloqueado, corrige supuesto falso de Fix 6 |
| `16735d4` | Agregado `'facebook'` al enum de `platforms` en `file.model.ts` (bug real, no dato corrupto) |
| `e57dd52` | `files.file_path` migrado de único-global a único-por-usuario; 19 arrays nulos normalizados. Script `mongo-filepath-index-and-normalize.js`. |
| `26440e3` | C1-C3: `bulkWrite({ordered:false})` + no reasignar `content_id` existente + `resolveOrCreateFile` graba `content_id` al crear |
| `908aa4f` | Corrección: C2 no beneficia a mobile hoy (verificado call site real, no solo DTO) + nota sobre bajar de Nube |
| `b62cc12` | Marca como desactualizado el cuerpo original del audit doc |
| `24f71e6` | Plan de instalación primaria única (alternativa a canonical_content_id+hash) |

Scripts reusables en `backend/scripts/`: `mongo-p0-index-fixes.js`,
`mongo-filepath-index-and-normalize.js` — ambos dry-run por default,
`--apply` para escribir, imprimen preflight/postflight/rollback.

## Qué sigue bloqueado (el único ítem pendiente del audit original)

**Índice único parcial de `content_id` en `files`/`backup_files`.**
Bloqueado por la revisión independiente: falta C4 (precedencia con
`backup_files.userId_1_file_name_1`) y pruebas reales de cliente
(Electron/iOS/Android/free) que no existen. Ver
`docs/mongo-remediation-review-2026-08-13.md` para el detalle completo.

Dos caminos evaluados para desbloquearlo:

1. **`canonical_content_id` + `content_hash`** (propuesto por otro agente,
   ver hallazgos H1-H12 y la sección de crítica en la conversación — no
   hay doc dedicado, quedó solo en el chat). Resuelve el problema con un
   sistema de identidad nuevo (ID emitido por la central + hash SHA-256
   opcional). Más grande: requiere que mobile también lo adopte, y el hash
   asume archivos byte-idénticos entre dispositivos (dudoso en un pipeline
   con `video-normalize.service.ts`/ffmpeg de por medio — sin confirmar).
2. **Instalación primaria única** (`docs/single-primary-install-plan-2026-08-14.md`,
   elegida para seguir explorando). Elimina la divergencia de raíz en vez
   de reconciliarla: solo una instalación por cuenta puede escanear/mintear
   `content_id`. Reusa `User.installId` (ya singular en el modelo, sin
   `teamId`/`linkedAccounts`). Cero cambios de esquema Mongo. Si se
   implementa, el índice de `content_id` queda desbloqueado por diseño
   (ya no puede haber divergencia), no solo mitigado.

**Decisión tomada dentro de la opción 2** (no implementada todavía): gate
duro (la secundaria no escanea ni tiene carpeta propia) + un flujo nuevo de
"subida simple ad-hoc" (un archivo por vez, sin catálogo persistente, que
reusa los uploaders existentes vía un `fileId` efímero) para no perder la
capacidad de publicar desde una PC secundaria. Detalle completo, con cómo
queda Historial/detección desde la primaria/Estadísticas/transcripción/
miniatura, en la sección "Decisión final" de `single-primary-install-plan-2026-08-14.md`.

## Qué falta para poder implementar la instalación primaria única

Ya no es "diseño abierto" — hay un plan de ejecución fase por fase en
`docs/primary-install-implementation-plan-2026-08-14.md` (Fase 0 a 5).

**Plan corregido, Fases A-D: implementadas y pusheadas** (commit `ab3051d`,
sobre `docs/primary-install-corrected-plan-2026-08-14.md`) — `device_id`
(tabla SQLite dedicada, sobrevive logout/wipe) separado de `install_id`
(sin cambios); `primaryDeviceId` nuevo en `User`, sin migrar
automáticamente; bootstrap con auto-claim sin contraseña en la primera
operación real; `claim-primary`/`installation-status`/`bulkUpsertBackupFiles`
migrados. Verificado con conteo exacto de `tsc --noEmit` antes/después
(0 errores nuevos). **No probado contra un cliente real todavía.**

**Sin implementar**: Fase E (cliente Electron consultando estado antes de
sync, UI ocultando nav local + banner "reclamar como principal") y Fase F
(tests automatizados/manuales). Fase G (ex-Fases 2-5 del plan original:
subida ad-hoc, C4, índice de `content_id`) sigue gateada detrás de E-F. Dos
cosas importantes que siguen valiendo del plan original:

1. **2 hallazgos de seguridad reales, verificados contra el código,
   independientes de `content_id`** — prioridad inmediata sin importar qué
   se decida sobre el resto:
   - `POST /api/auth/link-install` (`backend/src/controllers/auth.controller.ts:298-310`)
     pisa `User.installId` en **cada login**, sin condición — el campo que
     autoriza reset de contraseña/baja de cuenta cambia de dueño solo con
     loguearse en otra PC.
   - `bulkUpsertBackupFiles` (`backend/src/controllers/backup.controller.ts:330`)
     confía ciegamente en el booleano `fullSync` que manda el cliente, sin
     validar contra quién es la primaria real.
2. **Contrato corregido de `resolveOrCreateFile`** (bloqueaba Fase 2 hasta
   que se aclaró): la regla de "no vincular automáticamente con ambigüedad"
   NO debe aplicarse al caso de "cero candidatos" — eso rompería
   `recordPublish` de iOS/Android (que nunca manda `contentId` y depende de
   que 0 candidatos = crear registro nuevo). Contrato final documentado en
   la Fase 2 de `primary-install-implementation-plan-2026-08-14.md`.

El orden de ejecución acordado: Fase 0-1 (autoridad de primaria — los 2
hallazgos de seguridad) → Fase 2 (subida ad-hoc, contrato ya resuelto) →
Fase 3 (C4) → Fase 4 (índice) → Fase 5 (pruebas, en paralelo donde aplique).

## Contexto de la cuenta/uso real (para calibrar riesgo)

17 usuarios en la base, **1 solo con datos reales** de uso activo. El
escenario que motiva todo este trabajo (mismo usuario, dos PCs, mismo
archivo, `content_id` divergente) es real pero de baja frecuencia medida —
0 colisiones encontradas en los datos actuales. Vale la pena tenerlo
presente al priorizar cuánto esfuerzo meterle a esto contra otros pendientes
del producto.
