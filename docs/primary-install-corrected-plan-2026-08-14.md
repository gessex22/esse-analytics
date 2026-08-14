> **Este documento reemplaza las Fases 0-1 de
> `docs/primary-install-implementation-plan-2026-08-14.md`** a partir del
> bloqueante encontrado y documentado en
> `docs/primary-install-installid-lifecycle-blocker-2026-08-14.md`
> (`installId` no sobrevive un logout normal). Las Fases 2-5 de aquel
> documento (subida ad-hoc, C4, índice de `content_id`) siguen vigentes tal
> cual — acá se renombran G y se retoman recién al final.
>
> **Fases A-D: implementadas y pusheadas (commit ver HANDOFF).** `tsc --noEmit`
> verificado con conteo exacto antes/después vía `git stash` — 0 errores
> nuevos en `backend` y `local-backend`. **No probado contra un cliente real
> todavía** — falta Fase E (cliente Electron/frontend) y F (tests).
>
> **Revisión post-A-D (2026-08-14) encontró 3 problemas más, todos
> arreglados:** condición de carrera real en el auto-claim de bootstrap
> (`bulkUpsertBackupFiles` hacía find()+update incondicional, dos PCs
> nuevas pusheando a la vez podían las dos actuar como "primaria" y
> archivarse catálogo mutuamente — fix: `updateOne` con filtro condicional
> atómico); `upload-history.service.ts` mandaba `install_id` como si fuera
> `deviceId` al Historial (mismo bug de fondo, y de paso silenciaba el
> evento entero si `install_id` era `null`); `localResetPassword`/
> `localDeactivate` comparaban `installId` (se rompían tras el primer
> logout normal) — migrados a `primaryDeviceId`, que además es **más
> estricto** que antes (solo la PC principal, no cualquier dispositivo que
> alguna vez matcheó `installId`).

# Plan corregido: identidad de dispositivo + primaria segura

## Fase A — Introducir `device_id` local persistente

1. Tabla SQLite dedicada (no una key más en `app_config`, para que
   `wipeAll()` la excluya *por omisión* — su lista de tablas está
   hardcodeada y no la va a mencionar, en vez de depender de que alguien
   recuerde excluirla):
   ```sql
   CREATE TABLE device_identity (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     device_id TEXT NOT NULL
   );
   ```
2. `getOrCreateDeviceId()` — mismo patrón que `getOrCreateInstallId()`
   (`randomUUID()`, persistido), pero en esta tabla nueva.
   - `wipeAll()`, logout, `clearOwner()`, `owner/reset` y `reset-all` **no**
     la tocan.
   - Acción de soporte explícita nueva: "restablecer identidad de esta PC"
     — esa sí la rota. Pensada para cuando de verdad hace falta (la PC se
     va a vender, reinstalación limpia intencional), no para uso normal.
3. `install_id` sin cambios — sigue muriendo en logout/wipe, sigue
   autorizando reset de password/baja de cuenta, deja de participar en
   primaria/secundaria.

## Fase B — Separar el estado central

1. `UserModel`: agregar `primaryDeviceId?: string` (campo nuevo, no una
   reinterpretación de `installId`).
2. Migración: **no** rellenar `primaryDeviceId` con el `installId`
   existente — ese valor refleja "quién logueó último" por el bug viejo,
   no "quién es realmente la primaria". Todas las cuentas existentes
   arrancan con `primaryDeviceId: null`, incluida la única cuenta con datos
   reales de producción.
3. `installId` se mantiene para su función de seguridad original.

## Resolución del bootstrap (cerrada 2026-08-14, ver siguiente sección para el porqué)

El plan original dejaba esto ambiguo ("reclama la primaria de forma
explícita **o** mediante un flujo de bootstrap confirmado" — dos caminos
sin elegir). Se cierra así:

> **`primaryDeviceId` es `null` → auto-claim silencioso, sin contraseña, en
> la primera operación de catálogo válida.** No hay nada que proteger
> todavía — es la primera vez que esta cuenta ve un dispositivo. La
> contraseña (`claim-primary`) solo se exige para *reemplazar* una primaria
> **ya establecida**.

Sin esto, el día del deploy la única cuenta con datos reales arranca en
`null` y, si el bootstrap fuera el camino "duro" (403 hasta reclamar
explícito), quedaría bloqueada de su propia app sin saber que tiene que ir
a buscar un botón "Reclamar como principal". El auto-claim silencioso en el
primer uso mantiene el onboarding de una cuenta nueva sin fricción (como es
hoy) y solo agrega fricción al caso que sí hay que proteger: robarle la
primaria a alguien que ya la tiene.

## Fase C — Migrar Fase 0 al nuevo campo

Actualizar los endpoints ya implementados (`6608423`) para usar
`deviceId`/`primaryDeviceId` en vez de `installId`/`User.installId`:

- `link-install` (`auth.controller.ts::linkInstall`): vuelve a ser
  **solo** sobre `installId`, sin ninguna lógica de primaria — la separación
  de conceptos también aplica acá, no solo en el modelo.
- `GET /api/auth/installation-status`: recibe `deviceId`, compara contra
  `user.primaryDeviceId`. Reglas:

  | Estado | Resultado |
  |---|---|
  | `primaryDeviceId` vacío | Bootstrap: auto-claim silencioso (ver arriba), rol `primary`. |
  | Coincide con `deviceId` | Rol `primary`. |
  | No coincide | Rol `secondary`. |

- `POST /api/auth/claim-primary`: recibe `deviceId`, requiere contraseña
  actual (sin cambios respecto a Fase 0 original), actualiza únicamente
  `primaryDeviceId`. Auditoría (`primary_install_claimed`, ya existe el
  `AuditEventType`) con dispositivo anterior/nuevo — sin cambios de lógica,
  solo qué campo lee/escribe.

## Fase D — Corregir Fase 1 del backup

Migrar lo ya pusheado (`2614645`) de `installId` a `deviceId`:

```ts
const isPrimary = !user.primaryDeviceId || user.primaryDeviceId === deviceId; // bootstrap incluido acá
const fullSync = isPrimary && requestedFullSync === true;
```

- `bulkUpsertBackupFiles` rechaza con `403 PRIMARY_DEVICE_REQUIRED` (no
  degradación graceful esta vez, ahora que la identidad es estable de
  verdad) cuando `!isPrimary` **y** la operación es: `fullSync: true`,
  configuración persistente de `video_folder`, o cualquier operación que
  explícitamente escanee carpeta/sincronice catálogo completo. El bootstrap
  (`primaryDeviceId` vacío) **no** cae acá — ya está cubierto como `primary`
  por la fórmula de arriba, no hace falta un caso especial de "toleremos
  esto temporalmente".

  **Desviación deliberada al implementar (2026-08-14):** en
  `bulkUpsertBackupFiles` específicamente se mantuvo la degradación
  graceful (ignorar `fullSync`/no escribir `video_folder`, pero seguir
  aceptando el push de metadata/badges) en vez de un 403 duro, por dos
  motivos: (1) `video_folder` viaja en **todo** push regular de
  `pushFilesToCloud` como simple eco del config local, no solo cuando el
  usuario está *cambiando* la carpeta — un 403 basado en "el campo está
  presente" rechazaría el 100% de los pushes normales de una secundaria,
  no solo los que de verdad intentan reconfigurar algo; (2) el gate duro de
  verdad (que una secundaria ni siquiera tenga carpeta/scanner corriendo)
  es responsabilidad del cliente (Fase E, todavía sin implementar) — hasta
  que exista, un 403 acá bloquearía también el sync de badges/estadísticas
  que el propio plan de "instalación primaria única" quería preservar desde
  una secundaria. El 403 explícito sobre `autoDetectFolder`/
  `updateScanConfig`/`scanFolder` (los endpoints DEDICADOS de configurar
  carpeta) sigue pendiente como parte de Fase E.
- No confiar en `req.body.fullSync` como autorización (ya aplicado en
  `2614645`, se mantiene).
- `pushFilesToCloud` manda `deviceId` en vez de `installId` en el body.

## Fase E — Cliente y UX de primaria ✅ implementada 2026-08-14

**Estado: implementada y pusheada.** `tsc`/`build`/`lint` limpios en los 3
paquetes tocados; verificado en vivo con `?mock=1` (login owner, dashboard y
sidebar renderizan normal, `installation-status` no mockeado se resuelve
sin romper nada — gracefully degrada a `role` indefinido, mismo que
"primaria"). **No probado con un mock de `role: 'secondary'` todavía**, ni
contra Electron real.

- **Gate real server-side** (no solo cliente): `requirePrimaryDevice`
  (`local-backend/src/middleware/auth.middleware.ts`) aplicado a
  `POST /api/videos/scan/config`, `POST /api/videos/scan` y
  `POST /api/local/setup/auto-detect` — devuelve `403 PRIMARY_DEVICE_REQUIRED`
  si la central dice que esta instalación no es la primaria. Si la central
  no responde (offline), deja pasar (defensa en profundidad, no punto único
  de fallo).
- **Watcher de una primaria reemplazada**: `pushFilesToCloud` (que ya corre
  periódicamente) revisa `isPrimary` en la respuesta de la central y, si es
  `false`, llama `stopWatcher()` + marca `secondary_install` local — sin
  borrar ningún dato.
- **Frontend**: nuevo estado `installationRole` en `App.tsx` (consulta
  `backupService.getInstallationStatus()` al login), `isNavVisible` oculta
  Videos/Subir/Taller/Gemas cuando es secundaria (mismo criterio que modo
  remoto), banner "Esta PC es secundaria" con botón "Reclamar esta PC como
  principal" → modal de confirmación de contraseña →
  `backupService.claimPrimary(password)`.

Original (sigue siendo la referencia de diseño):

1. Al login: recuperar/generar `device_id`, consultar
   `installation-status`.
2. Primaria: carpeta, watcher, scan y sync completo habilitados (sin
   cambios respecto al comportamiento actual).
3. Secundaria: detener watcher/scan, ocultar nav local (mismo criterio que
   `LOCAL_ONLY_NAV` en modo remoto), banner + botón "Reclamar esta PC como
   principal", solo modo remoto + futura subida ad-hoc (Fase G/2 original).
4. Si la primaria fue reemplazada (alguien más hizo `claim-primary`): esta
   instalación se degrada sola en el siguiente sync, **sin borrar datos
   locales** — la información física sigue en el disco, solo deja de
   sincronizar como si fuera la autoridad.

## Fase F — Pruebas antes de retomar la Fase G (índice/ad-hoc)

- Logout/login en la misma PC conserva `device_id` y sigue siendo primaria
  (el test que directamente valida el fix del bloqueante).
- Login de otra cuenta en la misma PC no reutiliza `install_id`, pero
  conserva `device_id` — esa segunda cuenta hace su propio bootstrap sobre
  el mismo dispositivo físico, independiente de la primera.
- Login desde una segunda PC no reemplaza la primaria (sin claim explícito).
- Claim válido reemplaza la primaria y genera auditoría.
- Secundaria con `fullSync: true` recibe 403.
- Primaria puede hacer push/pull/wipe/pull sin archivar catálogo ajeno.
- Wipe, logout, `owner/reset` y `reset-all` preservan `device_id`.
- Rotación explícita de identidad ("restablecer identidad de esta PC") sí
  produce una nueva secundaria (bootstrap de nuevo desde cero para ese
  dispositivo).

## Fase G — Retomar Fase 2 e índice (ex-Fases 2-5 del plan original)

Solo cuando A-F estén desplegadas y probadas contra un cliente real:

1. Subida ad-hoc (contrato de `resolveOrCreateFile` ya corregido en el
   plan original — sigue vigente tal cual).
2. Reglas de conflicto de C4.
3. Índice único parcial de `content_id`.
4. Preflight + aplicar.

**Orden de entrega recomendado**: A+B+C+D en un solo cambio
backend/local-backend compatible (no tiene sentido migrar el campo a medias)
→ E (cliente/UX) y F (tests) después → G solo tras validar primaria estable
contra una PC real, no solo contra `tsc --noEmit`.
