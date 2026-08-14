# Bloqueante encontrado en Fase 1: `installId` no sobrevive un logout normal

Encontrado implementando Fase 1 de
`docs/primary-install-implementation-plan-2026-08-14.md`, 2026-08-14.
**Bloquea seguir con el gate de escaneo/carpeta y el frontend hasta
resolverse** — no es teórico, es la ruta de logout normal de la app.

## Cadena de evidencia (verificada, no supuesta)

1. `frontend/src/App.tsx:184-200` (`handleLogoutClick`) llama
   `POST /api/local/wipe` en cada logout normal del usuario — no es un caso
   raro ni una acción de "resetear instalación", es el botón de salir de
   sesión de todos los días.
2. `local-backend/src/routes/local-admin.routes.ts:61-73` (`POST /api/local/wipe`)
   llama `configRepo.wipeAll()`.
3. `local-backend/src/db/config.repo.ts:144`:
   ```js
   const tables = ['publishing_status', 'platform_videos', 'transcripts',
     'idea_videos', 'ideas_centrales', 'files', 'platform_config',
     'app_config', 'local_config'];
   ```
   `wipeAll()` hace `DELETE FROM app_config` — la misma tabla donde vive
   `install_id` (`config.repo.ts:119`, borrado también explícitamente desde
   `clearOwner()` con el mismo criterio: *"El secreto de instalación muere
   con la vinculación... evita reusarlo entre cuentas"*).
4. `local-admin.routes.ts::getOrCreateInstallId()` genera un `randomUUID()`
   **nuevo** la próxima vez que se llama, porque `configRepo.get('install_id')`
   ya no encuentra nada.

**Conclusión verificada**: cualquier logout + login normal en la misma PC
genera un `installId` local distinto al que ya está guardado en
`User.installId` (central).

## Por qué esto rompe el plan tal como está (y ya afecta lo shippeado en Fase 0)

El propósito ORIGINAL de borrar `install_id` en logout es correcto y no hay
que tocarlo: es un secreto que autoriza operaciones destructivas (reset de
password, baja de cuenta) atado a una sesión de cuenta — la app soporta
explícitamente que dos personas distintas usen la misma PC en momentos
distintos (`local-admin.routes.ts:92-103`, "Inicia un usuario DISTINTO al
dueño de esta PC"), y ese secreto no debe sobrevivir el cambio.

El problema es que **Fase 0 reusó el mismo campo para un propósito
distinto**: identificar de forma estable "esta PC física" para decidir
primaria/secundaria. Ese segundo propósito necesita sobrevivir logout/login
de la MISMA cuenta en la MISMA PC — justo lo contrario de lo que el diseño
original garantiza.

**Impacto concreto si no se arregla antes de continuar Fase 1**: el único
usuario con datos reales de producción, el día que cierre sesión y vuelva a
entrar en su propia PC de siempre, dejaría de matchear con
`User.installId` — perdería silenciosamente `fullSync` y permiso de
configurar carpeta (ya gateados server-side desde el commit `2614645`,
degradación graceful, no rompe nada hoy) y, si se llega a implementar el
resto de Fase 1 (gate duro de escaneo/carpeta con 403), quedaría bloqueado
de usar su propia app.

## Fix recomendado: separar los dos conceptos

No tocar `install_id` (secreto de cuenta, correcto como está). Agregar un
identificador **nuevo y separado**, con ciclo de vida distinto:

| Campo | Propósito | Sobrevive logout | Sobrevive wipe | Muere con |
|---|---|---|---|---|
| `install_id` (existente) | Autoriza operaciones destructivas de la cuenta activa | No | No | Logout, cambio de cuenta, wipe |
| `device_id` (nuevo, propuesto) | Identidad estable de ESTA instalación física, para primaria/secundaria | **Sí** | **Sí** | Solo desinstalación real / reset explícito de la instalación |

Implementación sugerida:
- `local-backend/src/db/config.repo.ts`: nueva función `getOrCreateDeviceId()`,
  mismo patrón que `getOrCreateInstallId()` (`randomUUID()`, persistido en
  `app_config`), pero **no** incluida en la lista de tablas/keys que
  `wipeAll()`/`clearOwner()` borran — o guardada en una tabla/key aparte que
  esos dos métodos no tocan.
- `User.model.ts` (central): agregar `deviceId?: string` (o renombrar el
  uso de `installId` en el contexto de `claim-primary`/`installation-status`
  para que use este campo nuevo en vez del `installId` de auth).
- `linkInstall`/`claimPrimary`/`getInstallationStatus` (ya implementados en
  Fase 0, commit `6608423`): cambiar de comparar `installId` a comparar
  `deviceId`. La lógica en sí (primera instalación registra, no se
  reemplaza sola, claim explícito con password) no cambia — solo qué campo
  usan.
- `bulkUpsertBackupFiles`/`pushFilesToCloud` (Fase 1 parcial, commit
  `2614645`): mismo cambio, mandar/comparar `deviceId` en vez de `installId`.

## Qué revisar de paso, mismo criterio

Antes de dar por bueno el fix, confirmar que `device_id` tampoco se ve
afectado por:
- `/api/local/owner/reset` y `/api/local/reset-all` (`local-admin.routes.ts:205,223`) —
  ¿deberían preservarlo también, o son genuinamente "borrar todo, incluida
  la identidad de esta PC"? Decisión de producto, no técnica — probablemente
  sí conservarlo (son para recuperar acceso cuando el login falla, no para
  "esta PC ya no es la misma PC").
- Confirmar en iOS/Android si existe un concepto equivalente a "installId
  de auth" separado de "identidad estable del dispositivo" — no se revisó
  todavía, mobile no estaba en el alcance de Fase 0/1 hasta ahora.

## Estado actual (para no repetir trabajo)

- **Fase 0**: implementada y pusheada, commit `6608423`. Sigue siendo
  correcta y útil (arregla el hallazgo de seguridad #1, `linkInstall`
  blindly-overwrite) — no depende de que `installId` sea estable entre
  logouts para ESE propósito específico (autorización de operaciones
  destructivas), que es exactamente para lo que `installId` sí está
  pensado.
- **Fase 1**: parcialmente implementada y pusheada, commit `2614645`
  (central valida `installId` en `bulkUpsertBackupFiles`, gatea
  `video_folder`, `pushFilesToCloud` manda `installId`). Degradación
  graceful, no bloquea nada hoy — pero su premisa de "primaria estable" está
  rota por el bug de este documento.
- **Bloqueado hasta resolver esto**: el resto de Fase 1 (gate duro de
  escaneo/carpeta con 403, cliente Electron consultando estado antes de
  sync, UI ocultando nav + banner "reclamar como principal") y todo lo que
  dependa de `claim-primary` siendo confiable.

## Próximo paso sugerido

1. Implementar `device_id` separado (fix de arriba).
2. Migrar Fase 0 (`linkInstall`/`claimPrimary`/`installation-status`) y
   Fase 1 parcial (`bulkUpsertBackupFiles`/`pushFilesToCloud`) para usar
   `device_id` en vez de `installId`.
3. Recién ahí seguir con el resto de Fase 1 (gate duro + frontend).
