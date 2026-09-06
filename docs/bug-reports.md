# Registro de bugs

Bitácora compartida para que cualquier agente pueda continuar una investigación
sin reconstruir el contexto. Agregar una entrada por incidente; no borrar las
resueltas. Los bugs que involucren contratos compartidos deben además seguir
`../LAB_FEATURE_PROMPT.md`.

## Cómo registrar un bug

Usar el siguiente formato:

```md
## BUG-AAAA-MM-DD-NN — título breve

- Estado: `abierto` | `en investigación` | `corregido` | `verificado` | `bloqueado`
- Reportado: YYYY-MM-DD
- Plataformas: iOS | Android | Web/Electron | Central | Laboratorio
- Severidad: baja | media | alta | crítica
- Reportado por: usuario | agente | monitoreo

### Síntoma y pasos para reproducir

### Resultado esperado / resultado observado

### Investigación

### Corrección

### Verificación y pendiente

### Historial
- YYYY-MM-DD — autor: cambio o hallazgo.
```

## Incidentes

## BUG-2026-09-06-04 — Un push de catálogo de la PC podía revertir en silencio un publish/link real ya confirmado del lado central

- Estado: `corregido` -- confirmado EN VIVO en producción (se reprodujo solo, sin buscarlo) y verificado que el fix lo resuelve. Typecheck limpio (27/27, ninguno nuevo).
- Reportado: 2026-09-06
- Plataformas: Central (afecta a cualquier cuenta con al menos una instalación de escritorio activa)
- Severidad: crítica -- pérdida silenciosa de datos ya confirmados, sin ningún error visible, reproducible con solo esperar a que corra un sync tick normal
- Reportado por: agente (encontrado en vivo al verificar el fix de BUG-2026-09-06-02)

### Síntoma y pasos para reproducir

Al aplicar el backfill de BUG-2026-09-06-02 para `final - linux gaming.mp4`
(Instagram), se verificó que `FileModel.platforms` quedó correcto
(`["tiktok","youtube","instagram"]`). ~30 segundos después, sin que nadie
tocara nada a propósito, `platforms` volvió a `["tiktok","youtube"]` --
Instagram desapareció de nuevo, aunque `platform_states.instagram` seguía en
`"confirmed"` (documento internamente inconsistente: el estado detallado
decía "hay un link real" pero el array plano que lee TODO lo demás --
Calendario, Cross-match, `getBackupFiles`, badges de Videos -- decía que no).

### Investigación

Causa raíz: `bulkUpsertBackupFiles` (`backend/src/controllers/backup.controller.ts`,
el endpoint que recibe el push periódico de catálogo de cada instalación de
escritorio -- corre en cada publicación local Y cada ~5-20 min vía
`syncOrchestrator.runSyncTick`, ver `frontend/src/services/syncOrchestrator.ts`)
escribe `platforms`/`platforms_discarded` en **`FileModel`** (no solo en
`BackupFileModel`) usando `resolvePlatforms()`, un helper que **solo protege
un caso**: "el push viene con `platforms` vacío Y ya había algo guardado". Si
el push viene con `platforms` NO vacío -- el caso normal, la copia de la PC
en su SQLite local -- ese valor **siempre gana, sin comparar nada contra lo
que ya hay en el central**. `FileModel` es la única de las 2 colecciones que
además tiene `platform_states` (`confirmed`/`badge_only`/`discarded`) -- un
publish real hecho del lado central (`applyPlatformPublish`, disparado por
ejemplo desde el link pegado en Nube, BUG-2026-09-06-02) puede confirmar una
plataforma que la PC todavía no conoce (no hizo `pull` todavía, o su próximo
push salió armado ANTES de enterarse) -- y el siguiente push de esa PC la
borra de `platforms` sin que nadie lo note, aunque `platform_states` quede
diciendo lo contrario.

Agravante de diseño: `runSyncTick` hace **push ANTES que pull**
(`syncOrchestrator.ts:21-22` -- `push()` primero, `pull()` después) -- incluso
si el `pull` de esa misma PC más tarde trajera el dato correcto de vuelta con
su propio LWW (que sí compara timestamps correctamente, ver `pullFromCloud`
en `local-backend`), el `push` que corrió segundos antes en el MISMO tick ya
alcanzó a pisar el dato central bueno primero.

`platforms_updated_at` en `FileModel` (el campo pensado para un LWW real,
"SYNC-01 #3") solo lo escribe este mismo `bulkUpsertBackupFiles` con el valor
que la PC reporta -- ningún otro caller que cambia `platforms` en `FileModel`
(`applyPlatformPublish`, `updateFilePlatforms`, el mirror de
`updateRemoteLibraryVideoPlatforms`) lo actualiza nunca, así que ni siquiera
había con qué comparar del lado central para una LWW real por timestamp.

### Corrección

`backend/src/controllers/backup.controller.ts::bulkUpsertBackupFiles` (rama
que escribe `FileModel`): antes de aceptar el `platforms`/`platforms_discarded`
que resuelve `resolvePlatforms()`, se le suman de vuelta todas las plataformas
que `FileModel` ya tiene como `platform_states: 'confirmed'` (y se las saca de
`platforms_discarded` si estuvieran ahí) -- un push de catálogo nunca puede
borrar ni descartar una plataforma con link real ya confirmado, sin importar
qué traiga. No es un LWW por timestamp (ese arreglo de fondo -- que todos los
callers bumpeen `platforms_updated_at` de verdad -- queda pendiente, ver
abajo); es una regla conservadora y suficiente para el caso que importa: un
link/publish real nunca se pierde en silencio.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/`: 27 errores, mismo baseline, ninguno
  nuevo.
- **Verificado en vivo contra producción**: se corrigió `final - linux gaming.mp4`
  a mano reusando `applyPlatformPublish` (`backend/src/scripts/refix-linux-gaming-2026-09-06.ts`,
  mismo codepath revisado, no un `updateOne` a mano) -- `platforms` volvió a
  incluir `instagram`, consistente con `platform_states`. Pendiente confirmar
  que sobrevive al PRÓXIMO push real de esa PC (el fix ya está en el código,
  pero no corre en el proceso real hasta reiniciar la central).
- **Pendiente crítico de siempre**: no corre en el proceso real detrás de
  `api.esse-analytics.com` hasta reiniciar ese proceso en la Mac -- en este
  caso puntual es más urgente que de costumbre, porque sin el reinicio el
  próximo push real de esa PC puede volver a pisar `final - linux gaming.mp4`
  (o cualquier otro archivo con un publish central reciente) exactamente
  igual que antes.
- **No implementado a propósito (fix de fondo, más grande)**: un LWW real por
  `platforms_updated_at` -- requiere que TODOS los callers que tocan
  `platforms`/`platforms_discarded`/`platform_states` en `FileModel`
  (`applyPlatformPublish`, `updateFilePlatforms`, el mirror de
  `updateRemoteLibraryVideoPlatforms`) bumpeen ese campo, y que
  `bulkUpsertBackupFiles` compare timestamps en vez de "incoming no vacío
  siempre gana". La regla de "nunca pisar un `confirmed`" ya cubre el caso
  más grave (perder un link real) sin necesitar ese trabajo más grande --
  queda como mejora de fondo, no bloqueante.
- **Alcance no verificado**: no se confirmó si `BackupFileModel` (la otra
  colección que toca el mismo endpoint, usada por Android/iOS vía
  `getBackupFiles`) tiene el mismo problema -- no tiene `platform_states`
  (solo `FileModel` lo tiene), así que la misma protección no aplica
  directo ahí. Sin investigar todavía.

### Historial
- 2026-09-06 — agente: encontrado en vivo (no buscado a propósito) al
  verificar que el backfill de BUG-2026-09-06-02 funcionara -- causa raíz
  confirmada citando el código exacto, corregido, dato de producción ya
  afectado reparado a mano con el mismo codepath revisado.

## BUG-2026-09-06-03 — Pegar el link de un video VIEJO en Nube lo hubiera marcado "publicado hoy" (fecha real pisada por `Date()` del cliente)

- Estado: `corregido` (backend, mitigado server-side) — typecheck limpio (27/27, ninguno nuevo). Los 3 clientes conservan el mismo bug de origen sin tocar (server ya no confía en su dato, ver Corrección).
- Reportado: 2026-09-06
- Plataformas: Central (mitigación); Electron, iOS, probablemente Android (bug de origen sin corregir en el cliente, ver Investigación)
- Severidad: alta -- silenciosa, distorsiona Estadísticas/Historial/Calendario con fecha falsa
- Reportado por: usuario (pregunta directa: "¿qué pasaría si hago eso con un video viejo?", haciendo referencia al backfill propuesto en [[BUG-2026-09-06-02]])

### Síntoma (potencial, atajado antes de que pasara en producción)

Al preguntar por las consecuencias del backfill de BUG-2026-09-06-02, se
encontró que el bug de origen es más amplio: pegar el link de un video
publicado hace semanas/meses (afuera de la app, recién ahora cargado) en el
editor de links de Nube -- en CUALQUIERA de los 3 clientes -- manda
`publishedAt = ahora` en vez de la fecha real de publicación. Eso hubiera
hecho que ese video apareciera "publicado hoy" en Estadísticas/Historial (con
el orden por fecha ya arreglado en BUG-2026-08-18-01, empujaría todo lo demás
para abajo) y corrido el "próximo" del Calendario para esa plataforma sin
ningún motivo real -- el mismo síntoma tipo "counter reseteado" que ya se vio
con `short - blu.mp4` (ver [[BUG-2026-09-05-03]]), pero producido a propósito
por el backfill en vez de por una publicación real.

### Investigación

Los 3 clientes arman el link a mandar con el mismo patrón:
`publishedAt: existing?.publishedAt ?? Date()` (o `new Date().toISOString()`
en Electron) -- **si no había un link previo para esa plataforma, siempre
manda "ahora"**, nunca `nil`/`undefined`:
- Electron: `EditRemoteLinksModal.handleSave`
  (`frontend/src/components/RemoteLibraryView.tsx:81`).
- iOS: `RemoteVideoDetailAdapter.writeLink`
  (`essenalytics-ios/.../RemoteLibrary/RemoteVideoDetailAdapter.swift:44-59`).
- Android: no verificado en este incidente (mismo patrón esperable, ver
  `PlatformUpdateOutbox.kt`/equivalente -- pendiente de confirmar).

`applyPlatformPublish` (`backend/src/controllers/backup.controller.ts:1090-1108`)
YA tiene exactamente la protección para esto -- un best-effort que resuelve la
fecha real desde la API de la plataforma (YouTube/Instagram/TikTok) vía
`getYoutube/Instagram/TiktokPublishedAt` -- pero **solo corre si
`publishedAt` llega `undefined`**. Un "ahora" generado por error en el
cliente pasa la prueba `if (!publishedAtDate)` como válido y desactiva la
protección -- exactamente el mismo patrón de bug ya documentado y corregido
en `recordUploadEvent` para OTRO caller (BUG-2026-08-15-06, comentario "OJO:
NO defaultear acá a `new Date()`"): ese fix nunca se replicó a este segundo
camino (el editor de links de Nube), que lo tiene igual en los 2 clientes
revisados.

### Corrección

Mitigado en un solo lugar (server), en vez de en cada cliente:
`backend/src/controllers/remote-library.controller.ts::updateRemoteLibraryVideoPlatforms`
-- el `publishedAt` que el caller manda solo se usa si YA había un link previo
para esa plataforma (`existingLink`, un timestamp real guardado de antes); si
es la primera vez que esta plataforma tiene un link real, se ignora lo que
haya mandado el cliente y se pasa `undefined` a `applyPlatformPublish` a
propósito, forzando su resolución real vía la API de la plataforma. No se
tocó ningún cliente -- el bug de origen (mandar `Date()`/`new Date().toISOString()`
quemado) sigue ahí en Electron/iOS, pero ya no tiene efecto porque el server
no confía en ese dato para el caso que importa.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/`: 27 errores, mismo baseline, ninguno
  nuevo.
- Pendiente crítico de siempre: no corre en el proceso real hasta reiniciar
  la central.
- **Pendiente, no urgente**: limpiar el bug de origen en los clientes
  (Electron `RemoteLibraryView.tsx`, iOS `RemoteVideoDetailAdapter.swift`,
  confirmar Android) para no depender solo de la mitigación server-side --
  mismo criterio que ya se aplicó correctamente en `LocalVideoDetailAdapter.swift`
  (iOS, la contraparte de Videos local) y en `recordUploadEvent`, que sí
  distinguen "hay link previo" de "es nuevo" y solo en el segundo caso mandan
  `nil`/omiten el campo.
- **Backfill de BUG-2026-09-06-02**: con esta mitigación ya en pie, el script
  de reconciliación pendiente ahí debe llamar `applyPlatformPublish` con
  `publishedAt: undefined` siempre (nunca reusar el `publishedAt` ya guardado
  en `platformLinks`, que para los casos afectados por este mismo bug puede
  ser "el momento en que se pegó el link", no la fecha real de publicación) --
  deja que el best-effort de la API de la plataforma resuelva la fecha real
  para cada video del backfill.

### Historial
- 2026-09-06 — agente: el usuario preguntó qué pasaría si el backfill
  propuesto en BUG-2026-09-06-02 se aplicara a un video viejo; investigado,
  confirmado el riesgo real (fecha falsa por default de cliente), mitigado
  server-side sin esperar a tocar los 3 clientes.

## BUG-2026-09-06-02 — Pegar un link real en Nube para una plataforma ya marcada "publicada" (badge) nunca propagaba a FileModel/PlatformVideoModel/Calendario/Estadísticas

- Estado: `corregido` (backend) — typecheck limpio contra el baseline (27/27, ninguno nuevo). **Backfill de los videos ya afectados en producción sin ejecutar todavía** (ver Pendiente).
- Reportado: 2026-09-06
- Plataformas: Central (afecta a los 3 clientes: Videos/Calendario/Estadísticas de Electron, iOS, Android)
- Severidad: alta — silenciosa, sin ningún error visible para el usuario
- Reportado por: usuario

### Síntoma y pasos para reproducir

El usuario: subió un video manualmente (fuera de la app) a una plataforma,
copió el link real y lo pegó en el detalle del video en iOS (Nube). Resultado:
el link no queda registrado del lado de Sincronizar/Estadísticas, Electron no
lo ve, Estadísticas no lo acomoda y el Calendario no avanza el "próximo" de
esa plataforma. Ejemplo concreto reportado: `final - linux gaming.mp4` sigue
ocupando un lugar en la pestaña Nube (3/5) pese a que, según el usuario, "hace
rato tenía que haberse publicado" -- ver la investigación de
[[BUG-2026-09-06-01]] arriba para el caso hermano (video sin FileModel).

### Investigación

Verificado en vivo contra Mongo Atlas de producción (read-only) con
`final - linux gaming.mp4` (`content_id 8837744b...`):

- `RemoteLibraryVideoModel` (Nube) tiene los 3 badges en `platforms` y un
  link REAL de Instagram (`platformLinks`, publicado 2026-09-05T18:44:16,
  `platformStates.instagram = "confirmed"`).
- `FileModel` (el catálogo real que usan Calendario/Cross-match/Videos) para
  el MISMO `content_id` solo tiene `platforms: ["tiktok","youtube"]` --
  **Instagram nunca llegó**, y no hay ningún `PlatformVideoModel` para ese
  `platformId` de Instagram en toda la cuenta.
- `platform_config.instagram.nextVideoId`/`nextRemoteLibraryVideoId`
  **siguen apuntando a este mismo video** -- nunca avanzaron, porque nada
  disparó `applyPlatformPublish` (la única función que llama a
  `syncCalendarAfterPublish`, la que mueve el "próximo" hacia adelante).
  Consecuencia directa: `remote-library-retention.service.ts::protectedFor()`
  sigue considerando este video "el próximo a publicar" de Instagram, así
  que el barrido de retención NUNCA lo libera de Nube -- de ahí que "siga en
  la Nube" pese a estar (según su propio badge) resuelto en las 3.

**Causa raíz exacta**: `updateRemoteLibraryVideoPlatforms`
(`remote-library.controller.ts`, el endpoint detrás de "pegar link" en Nube
tanto en Electron como en iOS/`RemoteVideoDetailAdapter.writeLink`) decidía
si un link era "novedad" (y por lo tanto si llamaba a `applyPlatformPublish`)
comparando contra `before.platforms` (el badge SI/NO) -- `if
((before.platforms ?? []).includes(link.platform)) continue;`. Secuencia real
que dispara el bug: (1) el usuario marca la plataforma como "publicada" a
mano (badge_only, toggle simple, SIN link -- típico de "ya lo subí afuera,
después pego el link"), eso entra a `platforms`; (2) más tarde pega el link
real para esa MISMA plataforma -- `link.platform` YA está en
`before.platforms` desde el paso 1, así que el `continue` se dispara y
`applyPlatformPublish` NUNCA se llama, aunque esta vez sí venga un link real.
El link queda guardado en `RemoteLibraryVideoModel.platformLinks` (por eso
"en Nube" se ve bien) pero invisible para todo lo demás.

### Corrección

`backend/src/controllers/remote-library.controller.ts::updateRemoteLibraryVideoPlatforms`:
la condición de "ya estaba, no es novedad" ahora compara contra el link REAL
anterior de esa plataforma (mismo `platformId` en `before.platformLinks`), no
contra el badge. Un badge_only que pasa a tener link real siempre dispara
`applyPlatformPublish`, sin importar que el badge ya estuviera en `true`.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/`: 27 errores, mismo baseline, ninguno
  nuevo.
- **Pendiente crítico de siempre**: no corre en el proceso real detrás de
  `api.esse-analytics.com` hasta reiniciar ese proceso en la Mac.
- **Backfill pendiente, sin ejecutar, a la espera de confirmación del
  usuario**: el fix es hacia adelante -- no repara solo el caso ya roto de
  `final - linux gaming.mp4` (ni otros que puedan existir con el mismo
  patrón). Re-pegar el mismo link ahí no alcanza (mismo `platformId` de
  antes -- el nuevo chequeo también lo trataría como "no es novedad", a
  propósito, para no re-disparar en cada edición sin cambios reales). Para
  reparar lo ya afectado hace falta un script de reconciliación puntual:
  recorrer `remote_library_videos` buscando `platformLinks` sin
  `PlatformVideoModel` correspondiente (mismo `platform`+`platformId`) y
  llamar `applyPlatformPublish` para cada uno -- mismo patrón que ya usa
  `getBackupPlatformVideos` para reconciliar `upload_history` huérfano. No
  se corrió todavía porque escribe en Mongo de producción (crea
  `PlatformVideoModel`, actualiza `FileModel`/`platform_config`) -- se
  ofrece como paso siguiente, no asumido.

### Historial
- 2026-09-06 — agente: investigado en vivo contra Mongo de producción con
  el caso concreto reportado por el usuario (`final - linux gaming.mp4`),
  causa raíz confirmada citando los 3 documentos involucrados, corregido en
  `remote-library.controller.ts`, typecheck limpio contra el baseline.
  Backfill de datos ya afectados en producción propuesto, sin ejecutar.

## BUG-2026-09-06-01 — Nube: un video subido/tocado ahí sin FileModel previo quedaba invisible para Calendario/Cross-match/Videos ("no corresponde a la línea")

- Estado: `corregido` (backend) — typecheck limpio contra el baseline (27/27, ninguno nuevo en los archivos tocados), sin probar en vivo contra producción todavía (requiere reiniciar el proceso de la central, ver nota de siempre sobre deploy)
- Reportado: 2026-09-06
- Plataformas: Central (afecta a los 3 clientes que leen Calendario/Cross-match/Videos)
- Severidad: media — no pérdida de datos del lado de la propagación, pero SÍ había riesgo latente de pérdida real de bytes (ver Mecanismo 2)
- Reportado por: usuario

### Síntoma y pasos para reproducir

El usuario reportó ver `short - blu.mp4` en la pestaña **Nube** de Electron
pese a haberlo "descartado hace rato", y que el video mostrado ahí "no
corresponde a la línea" (no es el que Calendario espera como próximo).

### Investigación

Verificado en vivo contra Mongo Atlas de producción (read-only, mismo
criterio que otros incidentes) con la cuenta del owner:

- Hay DOS videos reales distintos, coincidencia de nombre, no el mismo
  archivo: el de `FileModel` (`content_id 365efefd...`, descartado en
  Instagram/YouTube hace rato, publicado en TikTok recién el 2026-09-05) vs.
  el de `RemoteLibraryVideoModel`/Nube (`content_id 56f15b5f...`, subido
  DIRECTO a Nube el 2026-09-05 17:25, sin ningún `FileModel` asociado --
  `platforms: ["instagram","youtube"]`, nunca descartado en nada).
- Causa raíz real: **`handleRemoteLibraryTus`** (el callback de subida TUS,
  `remote-library.controller.ts`) crea el documento de Nube pero NUNCA
  resuelve ni crea un `FileModel` -- un video subido directo desde el
  celular sin catálogo previo en ninguna PC queda para siempre solo en Nube.
- Encima, **`updateRemoteLibraryVideoPlatforms`** (el toggle de
  publicado/descartado por plataforma que se hace DESDE la tarjeta de Nube)
  solo propagaba DESCARTES hacia `FileModel`, y encima solo `if (!file)
  return` -- si no había `FileModel` (como en este caso), el toggle se
  quedaba encerrado en `RemoteLibraryVideoModel` para siempre. Ni el
  publicar (badge sin link) ni el descartar llegaban nunca a
  Calendario/Cross-match/Videos para un video en esta situación -- de ahí
  "no corresponde a la línea": ese video literalmente nunca entró a la
  línea de publicación real, aunque el usuario lo estuviera gestionando
  desde Nube creyendo que sí.
- **Mecanismo 2, hallazgo aparte durante la misma investigación**: el TUS
  handler marcaba `safeToEvict: true` con solo que el upload trajera
  `contentId` (asumiendo "hay una copia local en algún lado"), sin verificar
  que existiera de verdad un `FileModel` con ese `content_id`. Para una
  subida directa desde el celular (sin PC de por medio) esos bytes son la
  ÚNICA copia real -- con el flag mal puesto, `remote-library-retention.service.ts`
  podía borrarlos apenas dejaran de ser "el próximo a publicar" de alguna
  plataforma. Pérdida de datos real y silenciosa, no confirmada en
  producción todavía (no se encontró evidencia de que ya haya pasado), pero
  el código lo permitía.

### Corrección

`backend/src/controllers/backup.controller.ts`:
- `resolveOrCreateFile` pasa a exportada (antes privada) -- ya existía
  exactamente para este propósito (usada por `updateFilePlatforms`), solo
  hacía falta reusarla desde el otro controller.

`backend/src/controllers/remote-library.controller.ts`:
- `handleRemoteLibraryTus`: antes de marcar `safeToEvict`, chequea si YA
  existe un `FileModel` con ese `content_id`. Si existe, `safeToEvict` sigue
  en `true` (comportamiento de siempre). Si NO existe, `safeToEvict: false`
  (protege la única copia real) Y se crea un `FileModel` mínimo vía
  `resolveOrCreateFile` -- best-effort, no bloquea la subida si falla.
- `updateRemoteLibraryVideoPlatforms`: el mirror hacia `FileModel` ahora (a)
  resuelve-o-crea el archivo en vez de exigir que ya exista, y (b) propaga
  tanto publicaciones nuevas (badge_only) como descartes nuevos, no solo
  descartes. Mismo criterio conservador de siempre: nunca pisa una
  plataforma que `FileModel` ya tiene como badge o descarte real.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/`: 27 errores, mismo baseline exacto que
  otros incidentes de esta sesión, ninguno nuevo y ninguno en los 2 archivos
  tocados.
- **Pendiente crítico de siempre**: este fix no corre en el proceso real
  detrás de `api.esse-analytics.com` hasta reiniciar ese proceso en la Mac.
- Pendiente: confirmar en vivo que un video subido directo a Nube desde el
  celular aparece después como candidato real en Calendario (getCalendarConfig)
  si queda alguna plataforma sin decidir.
- **No implementado a propósito**: no se tocaron los 2 documentos duplicados
  ya existentes de `short - blu.mp4` en `remote_library_videos` (los viejos,
  de la migración de catálogo, `storedFileName: null`) ni nada retroactivo
  sobre datos ya en producción -- el fix es hacia adelante. Si se quiere
  limpiar el caso puntual reportado, es una acción aparte (a definir con el
  usuario, no asumida acá).

### Historial
- 2026-09-06 — agente: investigado en vivo contra Mongo de producción,
  causa raíz confirmada (2 mecanismos), corregido en los 2 controllers,
  typecheck limpio contra el baseline.

## BUG-2026-09-05-03 — Calendario iOS: "Hoy" queda vacío tras publicar; posible off-by-one por fecha UTC vs. local

- Estado: `en investigación` — un mecanismo (reseteo de ciclo tras publicar) confirmado y esperado; un segundo mecanismo (UTC vs. local) confirmado por código pero sin confirmar si es la causa real de este reporte puntual
- Reportado: 2026-09-05
- Plataformas: iOS (síntoma), Central (causa del segundo mecanismo, comparte código con Android/Electron)
- Severidad: baja-media
- Reportado por: usuario

### Síntoma y pasos para reproducir

Tras publicar un video desde iOS, el usuario abre Calendario y no ve nada
para "Hoy" salvo el video recién publicado — esperaba ver algo más (otra(s)
plataforma(s) pendiente(s)) y sospecha que "se reinició el contador".

### Investigación

**Mecanismo 1 (esperado, no bug):** `syncCalendarAfterPublish`
(`backend/src/controllers/backup.controller.ts:847-900`) actualiza el
`platform_config` de la plataforma publicada — `lastPublishedDate = hoy`,
recalcula `nextVideoId` — scopeado estrictamente por
`{ userId, platform }` (línea 879-880), sin tocar las otras 2 plataformas.
En `CalendarView.swift`, `configs(for: .today)` (línea 44-52) exige
`nextDate <= hoy` — apenas se publica, `nextDate` de ESA plataforma salta al
próximo ciclo (fuera de "Hoy"), y lo único que queda visible ahí es la fila
verde "Publicado" (`publishedToday`, que lee `history`, no `configs`). Esto
es el comportamiento correcto SI esa era la única plataforma pendiente hoy —
sin confirmar todavía si el usuario tenía otras plataformas que también
deberían haber seguido apareciendo y desaparecieron (eso sí sería un bug
real, ya que la query está scopeada por plataforma y no debería tocarlas).

**Mecanismo 2 (bug real confirmado por código, relación con el síntoma sin
confirmar):** `lastPublishedDate` se guarda como
`publishedAt.toISOString().slice(0, 10)` (línea 888 del mismo archivo,
mismo patrón en `computeLastPublishedDynamic:1048`) — es la fecha en **UTC**,
no la fecha local del usuario. Para un usuario en una zona horaria detrás de
UTC (ej. México, UTC-6) publicando de noche, el "día" guardado puede ser el
día siguiente al real, corriendo un día hacia adelante `nextDate` (calculado
después en el cliente con calendario LOCAL, `CalendarDateSupport` en
`CalendarView.swift:260-322`, `timeZone = .current`). Esto podría hacer que
un ciclo que localmente vence hoy aparezca como si venciera mañana. No
confirmado si aplica al caso puntual reportado (haría falta saber la hora
exacta de la publicación y la zona horaria del usuario).

### Corrección

Sin implementar — anotado a pedido del usuario (mismo criterio que
BUG-2026-09-05-01/02). Si se confirma el Mecanismo 2 como causa real,
la corrección sería computar `lastPublishedDate` con la fecha LOCAL del
evento (necesitaría saber la zona horaria del dispositivo que publica, no
solo el timestamp UTC) en vez de `toISOString().slice(0,10)`.

### Verificación y pendiente

Pendiente: confirmar con el usuario (a) si otras plataformas además de la
publicada también desaparecieron de "Hoy" (Mecanismo 1 vs. bug real), y (b)
zona horaria + hora aproximada de la publicación, para evaluar si el
Mecanismo 2 aplica.

### Historial
- 2026-09-05 — agente: reportado por el usuario ("no sale nada para hoy en
  Calendario iOS, parece bugeado"); 2 mecanismos identificados por lectura de
  código, ninguno implementado, a la espera de confirmación del usuario.

## BUG-2026-09-05-02 — "Videos" (PC): archivos viejos descartados en las 3 plataformas no aparecen en la vista por defecto

- Estado: `en investigación` — causa confirmada para el caso general (filtro por diseño), hipótesis sin confirmar para por qué el usuario no los encuentra ni con el filtro "Completos"
- Reportado: 2026-09-05
- Plataformas: Web/Electron (PC), posible origen en iOS/central (ver BUG-2026-09-05-01)
- Severidad: media
- Reportado por: usuario

### Síntoma y pasos para reproducir

En la vista "Videos" del escritorio, algunos videos viejos que el usuario
descartó (en las 3 plataformas) no aparecen marcados como descartados.

### Resultado esperado / resultado observado

Esperado: poder encontrar esos videos y ver su estado de descarte reflejado.
Observado: no aparecen en la cola/lista tal como el usuario la mira.

### Investigación

Dos causas confirmadas por lectura de código, no necesariamente excluyentes:

1. **Filtro por diseño de la vista principal.** `fileRepo.findAll` en
   `local-backend/src/db/file.repo.ts:137-139` — sin que el usuario elija un
   estado a mano, `VideosView.tsx:493` manda `content_status: "no_completo"`,
   que en SQL es `json_array_length(platforms) + json_array_length(platforms_discarded) < 3`.
   Un archivo descartado en las 3 plataformas (`platforms_discarded.length === 3`)
   queda **excluido de la vista por defecto** a propósito — mismo criterio que
   ya documenta el comentario de `getBackupFiles` en el backend
   (`backend/src/controllers/backup.controller.ts:38-39`). Existe un chip
   "Completos" (`VideosView.tsx:1045-1046`, `content_status: "completo"`) que
   sí debería traerlos — sin confirmar todavía si el usuario lo probó y
   tampoco aparecieron ahí.
2. **Posible video sin fila local.** `pullFromCloud`
   (`local-backend/src/controllers/backup-sync.controller.ts:260-263`) nunca
   CREA una fila en la SQLite local para un archivo que solo existe en la nube
   — si no encuentra un `localFile` que matchee (por `content_id` o
   `file_name`), lo cuenta como `orphans++` y sigue, sin insertar nada. Un
   video grabado/importado y descartado 100% desde el celular, cuyo archivo
   físico nunca estuvo (o ya no está) en la carpeta de la PC, **no puede
   aparecer en "Videos" bajo ningún filtro**, porque esa vista lista filas de
   `files` en SQLite, no el catálogo de la nube. Coincide con "datan de fechas
   muy viejas" (candidatos más probables a haber sido borrados del disco de la
   PC con el tiempo) pero no está confirmado que sea el caso real del usuario.

### Corrección

Sin implementar. Pendiente confirmar con el usuario, por cada video puntual
que reporte: (a) si aparece al tocar el chip "Completos" en Videos, y (b) si
el archivo físico todavía existe en la carpeta de video_folder de esa PC —
eso separa la causa 1 (filtro/UX) de la causa 2 (nunca hay fila local que
mostrar, requeriría que el pull empiece a crear filas "solo lectura" para
archivos cloud-only, cambio de alcance mayor).

### Verificación y pendiente

Pendiente de investigar con casos concretos del usuario.

### Historial
- 2026-09-05 — agente: reportado por el usuario junto con BUG-2026-09-05-01;
  dos causas candidatas identificadas por lectura de código, sin confirmar
  cuál aplica ni implementar nada, a pedido del usuario (solo anotar).

## BUG-2026-09-05-01 — Descarte y precarga a Nube desde el celular no se reflejan "al momento" en la PC

- Estado: `en investigación` — causa raíz confirmada por lectura de código (arquitectura conocida, no un bug puntual nuevo); ya había un plan de fix sin implementar para el mismo gap
- Reportado: 2026-09-05
- Plataformas: iOS (origen del evento), Web/Electron (PC, donde no se ve)
- Severidad: media
- Reportado por: usuario

### Síntoma y pasos para reproducir

1. Descartar una plataforma de un video desde iOS → no se ve reflejado en la
   PC al revisarla poco después.
2. Publicar/subir un video desde el celular → la precarga a Biblioteca remota
   (Nube) no se dispara "al momento" en la PC.

### Resultado esperado / resultado observado

Esperado: el cambio hecho en el celular se refleja en la PC en tiempo
razonablemente corto. Observado: puede tardar varios minutos o no aparecer
hasta que algo puntual dispare una sincronización en la PC.

### Investigación

Ambos síntomas comparten la misma causa raíz: no existe ningún canal de
notificación push central→Electron. La PC solo se entera de cambios hechos
en otro dispositivo cuando ella misma corre `runSyncTick()`
(`frontend/src/services/syncOrchestrator.ts:16-24`) — push + pull + 
`ensurePreload()` como una sola unidad, con un cooldown COMPARTIDO de 5
minutos (`MIN_GAP_MS`). Ese tick se dispara:
- al montar la app (forzado, `useSyncOrchestrator.ts:26`),
- al recuperar foco/visibilidad de la ventana (sin forzar, sujeto al cooldown),
- cada 20 min de fallback (`FALLBACK_INTERVAL_MS`),
- al entrar a "Videos" (`VideosView.tsx:526`, sin forzar).

Si el usuario vuelve a mirar la PC dentro de los 5 minutos del último tick
(común si la app ya estaba abierta y con foco reciente), ni el pull (síntoma
1) ni `ensurePreload()` (síntoma 2) vuelven a correr, así que el cambio hecho
en el celular quedó "de verdad" en la central pero la PC todavía no fue a
buscarlo.

Esto NO es un hallazgo nuevo: está anotado como pendiente en
`docs/instant-matches-stats-plan-2026-08-31.md`, Fase 7 — Paso 3
("invalidación inmediata dentro del mismo dispositivo") y Paso 4
("notificación cross-device", propone SSE) — con una "Entrega 1" ya diseñada
(bus de eventos local, sin necesitar SSE todavía) pero sin implementar. Ese
plan nace de una queja anterior sobre demoras en Estadísticas/Matches, pero
el mecanismo de fondo (cooldown compartido de `runSyncTick`, sin push
cross-device) es el mismo que explica este reporte.

### Corrección

Sin implementar — a pedido del usuario, se deja solo anotado por ahora.
Alcances posibles para retomar (de menor a mayor esfuerzo), a decidir con el
usuario cuando se priorice:
1. Fix acotado: que el `pull` (no el push/ensurePreload) corra sin cooldown
   en focus/mount/Videos — trae cambios ajenos más rápido sin aumentar la
   carga de escritura hacia la central.
2. "Entrega 1" del plan de `instant-matches-stats-plan-2026-08-31.md`
   (invalidación local inmediata tras publicar en el mismo dispositivo) — no
   cubre el caso celular→PC de este reporte, solo mismo-dispositivo.
3. Paso 4 del mismo plan (canal SSE central→Electron) — el único que de
   verdad resuelve la propagación cross-device sin esperar ningún tick.

### Verificación y pendiente

Sin implementar, nada que verificar todavía.

### Historial
- 2026-09-05 — agente: reportado por el usuario junto con BUG-2026-09-05-02;
  causa raíz identificada por lectura de código (cooldown compartido de
  `runSyncTick`, sin canal push cross-device), coincide con gap ya documentado
  en `docs/instant-matches-stats-plan-2026-08-31.md`. Anotado a pedido del
  usuario, sin implementar.

## BUG-2026-08-31-01 — iOS: videos de Biblioteca LAN no desaparecen cuando dejan de estar disponibles

- Estado: `abierto` (solo anotado, sin investigar todavía)
- Reportado: 2026-08-31
- Plataformas: iOS
- Severidad: media
- Reportado por: usuario

### Síntoma y pasos para reproducir

En el modo "Biblioteca LAN" (iOS apuntando por LAN al local-backend de una
PC, ver `PLAN_LAN_PICKER_Y_REPRODUCTOR-2026-08-18.md` y
`lan-library-auto-switch-design-2026-08-16.md` en `UIEssePanel/`), un
video que deja de estar disponible en la PC (borrado, carpeta cambiada,
PC apagada/desconectada de la red) sigue apareciendo en la lista del
celular en vez de desaparecer.

### Resultado esperado / resultado observado

Esperado: el video deja de listarse (o se marca claramente como no
disponible) cuando el local-backend de la PC ya no lo reporta / no es
alcanzable. Observado: queda visible como si siguiera disponible.

### Investigación

No arrancada. Sin verificar todavía: si el catálogo LAN en iOS cachea la
lista sin revalidar contra la PC en cada apertura/refresh, si hay algún
TTL, o si el gap está del lado del local-backend (no reporta bien que un
archivo ya no existe hacia ese endpoint puntual) vs. del cliente (nunca
re-consulta / no reacciona a una respuesta que ya no incluye ese video).
Revisar primero `ImportUseCase`/`LocalBackendUploadAPI.swift` (iOS) y el
mismo patrón de "Catálogo PC" ya documentado para Android en memoria
(`chip Catálogo PC`, `BackupCatalogAPI`).

### Corrección

Pendiente.

### Verificación y pendiente

Pendiente de investigar.

### Historial
- 2026-08-31 — usuario: reportado, anotado sin investigar todavía.

## BUG-2026-08-30-02 — Calendario: "Vencido" deja de ser un bucket/urgencia propia, se fusiona con "Hoy" (CALENDAR-01)

- Estado: `corregido`; verificado con build real en iOS (ver abajo). Pendiente de build real en Android (Electron sí compiló y lintió limpio).
- Reportado: 2026-08-30
- Plataformas: iOS, Android, Web/Electron
- Severidad: baja (decisión de UX, no bug de datos)
- Reportado por: usuario

### Contexto

No es un bug de datos: investigado a fondo (ver memoria `mobile_audit_2026_08_30_refresh_sync_thumbs.md`), no existe ningún sistema de "video asignado a un día fijo que necesite reprogramarse". El calendario real es 100% cadencia por plataforma (`lastPublishedDate + intervalDays`, calculado client-side en los 3 clientes), y "vencido" ya era un estado calculado correctamente en los 3 — solo el TRATAMIENTO visual era inconsistente (Electron y iOS-recién-ayer lo agrupaban en una sección roja separada "Vencido"; Android lo marcaba con badge por tarjeta sin agrupar).

### Decisión del usuario

Simplificar en vez de unificar hacia el diseño más elaborado: un pendiente vencido (nextDate en el pasado, sin publicar) se trata **idéntico** a uno de "Hoy" — mismo color, mismo label, sin contador de días vencidos ni sección separada. Reemplaza por completo el fix `2026-08-29` de iOS (`case .overdue`) que había agregado justo la sección separada para tener paridad con desktop — paridad que ahora se logra en la dirección contraria.

### Corrección

- **iOS** (`CalendarView.swift`): se eliminó `case overdue` de `CalendarScheduleGroup.Kind`; `contains` de `.today` pasa de `days == 0` a `days <= 0`. Solo quedan `.today`/`.tomorrow`.
- **Android** (`CalendarScreen.kt`): `UrgencyPill` ya no distingue `days < 0` — color `UrgencyToday`, ícono `Schedule` (antes `WarningAmber`), label `"Hoy"` (antes `"Venció Nd"`) para cualquier `days <= 0`. Imports `WarningAmber`/`UrgencyPast` removidos por quedar sin uso en este archivo.
- **Electron** (`PublishingQueue.tsx`): tipo `Urgency` pierde el miembro `"past"`; `getUrgency` funde `d < 0` en `"today"`; se eliminó la sección "Vencido — publicar ahora" (bucket `overdueB`, siempre vacío ahora), el banner "⚠ N plataformas vencidas" del header, el borde rojo + botón "Publicar" rojo de `UpcomingCard`, y la sombra roja de `PlatformCard`. Imports `AlertTriangle`/`ArrowRight` removidos por quedar sin uso.

### Verificación y pendiente

- Electron: `npm run lint` (0 errores) y `npm run build` (build limpio) — verificado en este entorno.
- **iOS: build real verificado** vía SSH a la Mac del usuario (`macgessemberg22`, ver [[ios_ssh_build]]) — `xcodebuild build -destination "generic/platform=iOS Simulator"`, `EXIT=0`, cero `error:` en el log completo (931 líneas), sin ningún warning nuevo en `CalendarView.swift` (los únicos warnings del log son preexistentes, de concurrencia Swift 6 en otros archivos). Antes de sincronizar se comparó el diff del archivo entre Windows y la Mac: la única diferencia eran justo los cambios de esta sesión — la Mac no tenía trabajo propio distinto en ese archivo puntual (sí tiene otros 3 archivos con cambios sin commitear ajenos a esta sesión — `Colors.swift`, `PublishOptionsFields.swift`, `HistoryView.swift` — que NO se tocaron ni se sincronizaron).
- Android: no compilable desde este entorno Windows (ver trampa de entorno en `UIEssePanel/CLAUDE.md`). Verificado a mano (switches exhaustivos, imports sin uso removidos). Pendiente build real en Android Studio/gradlew.

### Regresión encontrada por el usuario tras el build (mismo día)

Tras instalar el build, el usuario reportó ~62 videos viejos apareciendo
como "publicados hoy" en la lista de Historial/publicados del Calendario
iOS. Causa: `CalendarScheduleGroup.Kind.contains(_:)` se reutilizaba para
DOS cosas distintas — filtrar la fecha de cadencia calculada (`nextDate`,
donde "vencido cae en Hoy" es el comportamiento querido) Y filtrar fechas
REALES de `publishedAt` en `publishedToday()` (historial, hasta 60
registros) — ahí `días <= 0` matchea casi cualquier publicación pasada, no
solo la de hoy.

Fix: el fold "vencido → Hoy" se movió de `Kind.contains` (genérico) a
`configs(for kind:)` (específico de la fecha de cadencia). `Kind.contains`
vuelve a su semántica original de día exacto (`days == 0` para hoy), que es
lo correcto para `publishedToday()` y para cualquier otro uso futuro sobre
fechas reales.

### Historial
- 2026-08-30 — agente: investigación (CALENDAR-01A) descartó la hipótesis de rollover de fecha fija; implementado el fix de simplificación acordado con el usuario en los 3 clientes.
- 2026-08-30 — agente: verificado con build real en iOS (SSH a la Mac), exit 0, sin errores.
- 2026-08-30 — agente: usuario reportó regresión (62 videos como "publicados hoy"); causa raíz encontrada (`Kind.contains` reusado para fecha de cadencia Y fecha real de historial); corregido separando ambos usos; reverificado con build real, exit 0, sin errores.

## BUG-2026-08-30-01 — Android: pull-to-refresh de Dashboard/Calendario devolvía datos cacheados (REFRESH-01)

- Estado: `corregido`; pendiente de verificación con build real (Android Studio/gradlew).
- Reportado: 2026-08-30
- Plataformas: Android
- Severidad: media
- Reportado por: usuario (brief de auditoría de refresh móvil)

### Síntoma y pasos para reproducir

En Android, publicar/editar un dato (desde otro dispositivo o el mismo) y tirar
para refrescar Dashboard o Calendario dentro de los ~30s siguientes no trae el
dato nuevo — hace falta cerrar y reabrir la app para verlo.

### Resultado esperado / resultado observado

Esperado: un pull-to-refresh explícito siempre ignora cualquier caché y trae
el estado actual del backend. Observado: dentro de la ventana de TTL de la
caché compartida, el refresh manual devolvía silenciosamente la misma
respuesta cacheada, sin red de por medio.

### Investigación

`SyncRepository` (`core/network/src/.../SyncRepository.kt`) cachea
`getGroupStats`/`getCalendarConfig`/`getHistory` con un TTL de 30s
(`Timed.expired()`), pensado para evitar refetch al cambiar de tab. Cada
método acepta `force: Boolean = false` para bypasear la caché a propósito.
`DashboardViewModel.refresh()` y `CalendarViewModel.refresh()` — ambos
conectados directo a `PullToRefreshBox(onRefresh = viewModel::refresh)` —
llamaban a `getGroupStats`/`getCalendarConfig` SIN `force = true`, mientras
que la misma función sí lo hacía para `getHistory` (Dashboard) y mientras que
`StatsViewModel.refresh()` sí lo hacía correctamente para su propio
`getGroupStats`. Es decir: el mecanismo correcto ya existe y ya está probado
en el mismo código, solo faltaba propagarlo de forma consistente.

Además, en ambos ViewModels `init { refresh() }` compartía la misma función
que el pull-to-refresh — de haber agregado `force = true` directo ahí, la
carga inicial (o un ViewModel recreado con caché aún tibia de otra pantalla)
hubiera perdido el beneficio de la caché compartida sin necesidad.

### Corrección

En `DashboardViewModel.kt` y `CalendarViewModel.kt`: se separó el cuerpo de
`refresh()` en un `private fun load(force: Boolean)`. `init` ahora llama
`load(force = false)` (conserva el aprovechamiento de caché en carga
inicial/navegación), `refresh()` llama `load(force = true)` (bypass real de
caché, semántica correcta de un pull-to-refresh explícito). `getHistory`
sigue forzando siempre en Dashboard (comportamiento preexistente, sin tocar).

### Verificación y pendiente

No compilable desde este entorno (Windows sin Gradle real — ver trampa de
entorno en `UIEssePanel/CLAUDE.md`). Pendiente que el usuario corra
`./gradlew` desde Android Studio y confirme en dispositivo real:
- Dashboard: publicar/editar desde otro dispositivo, volver y refrescar antes
  de que pasen 30s → debe traer el dato nuevo.
- Calendario: mismo caso.
- Estadísticas/Historial (ya correctos antes de este fix) sin regresión.
- Cambiar de tab rápido sigue sin generar refetch de más (init sigue
  aprovechando la caché).

### Historial
- 2026-08-30 — agente: causa raíz identificada y fix aplicado; sin build real todavía.

## BUG-2026-08-24-01 — iOS fallaba al eliminar un video desde la lista Videos

- Estado: `corregido`; pendiente de verificación en dispositivo.
- Reportado: 2026-08-24
- Plataformas: iOS
- Severidad: alta (podía cerrar la app o aparentar un borrado que luego se revertía)
- Reportado por: usuario

### Síntoma y pasos para reproducir

En iOS, abrir **Videos**, deslizar una fila y tocar **Eliminar**. El primer
arreglo evitó parte de los abortos al confirmar, pero el usuario verificó que
la app todavía podía cerrarse casi inmediatamente después de abrir el cuadro
con las opciones local/Nube, antes de elegir una. Si el video incluía una copia
en Nube, un fallo HTTP también podía ocultarse y la fila reaparecía al refrescar.

### Investigación

El cierre del swipe/diálogo podía coincidir con la paginación de Nube y con dos
mutaciones separadas de la lista fusionada: borrar el `FileEntity` local hacía
aparecer temporalmente su copia remota y después el paginador la quitaba. Para
UIKit eran varios cambios estructurales superpuestos sobre el mismo `List`.
Además, el `try?` del borrado remoto descartaba cualquier error del servidor.

La recurrencia del 2026-08-25 mostró dos riesgos que seguían activos:

- `confirmationDialog` se montaba desde el botón del swipe mientras el `List`
  todavía animaba el cierre de esa misma fila. El crash ya no dependía de que
  el usuario confirmara una eliminación.
- La identidad compartida Local/Nube podía asignar el mismo `remote_<id>` a
  más de una copia local vinculada o con el mismo nombre. Eso dejaba IDs
  duplicados en `ForEach`; una actualización inocua, como presentar el cuadro,
  podía hacer fallar el diff interno de `UICollectionView`.

### Corrección

- El `List` permanece montado al quedar vacío y el spinner de paginación es un
  overlay, no una fila condicional.
- La precarga se pausa mientras el diálogo o el borrado están activos.
- Local y Nube comparten identidad visual únicamente cuando el vínculo es
  inequívoco y uno-a-uno; las copias ambiguas conservan IDs locales únicos.
- En un borrado conjunto se confirma Nube primero y luego se aplican juntas las
  mutaciones del paginador y SwiftData en `MainActor`.
- Los errores remotos se muestran y ya no se retira la fila fingiendo éxito.
- El fallback por nombre solo vincula videos cuando la coincidencia es única,
  evitando borrar otra copia con el mismo nombre.
- El `confirmationDialog` del sistema se reemplazó por un panel propio fuera
  del `List`. El snapshot se captura al tocar el swipe, pero el panel se monta
  en el siguiente tick; al confirmar, el panel se desmonta antes de mutar
  SwiftData o el paginador.

### Verificación y pendiente

- Build real con Xcode 26.5 para iOS Simulator: `BUILD SUCCEEDED` tras la
  corrección de la recurrencia.
- `git diff --check`: correcto.
- Pendiente: repetir en el dispositivo el borrado local, remoto y conjunto,
  incluido el último video visible.

### Historial

- 2026-08-25 — usuario: confirmó que el crash seguía ocurriendo casi al abrir
  el cuadro local/Nube, sin llegar a elegir una acción.
- 2026-08-25 — Codex: retiró la presentación del sistema del ciclo del swipe y
  limitó la identidad Local/Nube a vínculos 1:1; build real exitoso por Xcode.
- 2026-08-24 — Codex: corrección de carreras de estado y manejo de error
  remoto aplicada sobre el arreglo previo del diálogo.

## BUG-2026-08-18-01 — Estadísticas "Comparadas" ordena por fecha de creación del archivo, no por cuándo se completó el match de las 3 plataformas

- Estado: `corregido`; pendiente deploy de la central + verificación visual en los 3 clientes.
- Reportado: 2026-08-18
- Plataformas: Central (afecta a los 3 clientes que consultan `/api/sync/group-stats` sin `platform` — usuario confirma que en mobile no se nota igual, pero el endpoint es el mismo para los 3)
- Severidad: media (orden equivocado en una lista, no pérdida de datos)
- Reportado por: usuario

### Síntoma y pasos para reproducir

En Estadísticas, pestaña "Comparadas" (las que exigen YouTube+Instagram+TikTok
resueltos), el usuario esperaba ver primero el video que más recientemente
terminó de resolver sus 3 plataformas — pero el orden real no corresponde a eso.

### Investigación

`getGroupStats` (`backend/src/controllers/sync.controller.ts:555`) tiene dos
caminos según si viene `?platform=`:

- **Con `platform`** (pestañas individuales YouTube/Instagram/TikTok): arranca
  desde `PlatformVideoModel` y ordena por `publishedAt` real de esa plataforma
  (línea 585, `.sort({ publishedAt: -1 })`) — correcto.
- **Sin `platform`** (pestaña "Comparadas", `filter === 'all'` en
  `StatsView.tsx:311`, manda `getGroupStats(10, undefined)`): arranca desde
  `FileModel` y ordena por **`fecha_creacion`** (línea 626,
  `.sort({ fecha_creacion: -1 })`).

`fecha_creacion` **no es una fecha de publicación de nada** — es el `mtime`
del archivo en disco, capturado una sola vez por el watcher cuando lo detecta
por primera vez (`local-backend/src/watcher.ts:38/112`,
`fs.statSync(absPath).mtime`). No tiene ninguna relación con cuándo se
resolvió el link de YouTube, Instagram o TikTok para ese archivo.

Consecuencia real: un video importado/editado en disco hace mucho pero cuyo
tercer link (ej. TikTok) se resolvió recién ahora queda "abajo" en la lista
(su `fecha_creacion` es vieja), mientras un video con `fecha_creacion` reciente
pero publicado/matcheado hace tiempo aparece "arriba". El campo que la
respuesta expone como `fecha_creacion` en cada ítem (línea 714-716) también
hereda el mismo problema en esta rama — no es solo el orden de la lista, el
dato mostrado por ítem tampoco es una fecha de publicación real cuando no hay
`platform` en el query.

### Corrección

`backend/src/controllers/sync.controller.ts::getGroupStats`, rama sin
`platform` ("Comparadas"):

- Helper nuevo `latestPublishedAt(pvs)` — el `publishedAt` más reciente entre
  los `PlatformVideoModel` linkeados a un archivo (o `null` si ninguno tiene
  fecha).
- Justo después de construir `byFile`, `files` se reordena en JS con ese
  valor (`latestPublishedAt` de cada archivo, descendente) — reemplaza al
  `.sort({fecha_creacion:-1})` de Mongo, que queda solo como orden de arranque
  sin efecto real (se comenta explícitamente por qué se deja).
- El campo `fecha_creacion` de cada item (antes `f.fecha_creacion` siempre en
  esta rama) pasa a usar `latestPublishedAt(pvs) ?? f.fecha_creacion` —
  mismo criterio, con fallback a la fecha del archivo solo si ningún link
  tiene `publishedAt` real (no debería pasar en la práctica, ya que `pvs`
  solo llega hasta acá si las 3 plataformas están completas).
- La rama CON `platform` (pestañas individuales) no se tocó — ya ordenaba
  correcto por `publishedAt`.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/`: 27 errores, mismo baseline que ya
  documentan otros incidentes de esta sesión (BUG-2026-08-15-06, etc.),
  ninguno nuevo y ninguno en el archivo tocado cerca de este cambio.
- **Pendiente crítico**: como con cualquier fix de `backend/`, el código
  nuevo no corre en el proceso real detrás de `api.esse-analytics.com` hasta
  que no se reinicie con este cambio (ver el mismo pendiente en
  BUG-2026-08-15-06).
- Pendiente: confirmar visualmente en Estadísticas ("Comparadas") que el
  primer ítem es de verdad el que más recientemente completó las 3
  plataformas, en los 3 clientes.

### Historial
- 2026-08-18 — usuario + agente: causa raíz encontrada leyendo `getGroupStats`
  y `watcher.ts` (confirmado que `fecha_creacion` = mtime del archivo, no
  fecha de publicación), documentada.
- 2026-08-18 — agente: corregido (reorder por `latestPublishedAt` + campo
  `fecha_creacion` de la respuesta ajustado), `tsc` limpio contra el mismo
  baseline. Deploy de la central pendiente.

## BUG-2026-08-16-03 — Modo "PC local" (LAN) en iOS: cola con nombre+flechas pero sin reproductor/miniatura

- Estado: `corregido` (2026-08-18) — iOS verificado por build real vía SSH (exit 0); Android sin verificar (sin camino de build, ver `../CLAUDE.md`).
- Reportado: 2026-08-16
- Plataformas: iOS, Android
- Severidad: baja
- Reportado por: usuario (desde "batiphone", ver memoria de sesión sobre dispositivos)

### Síntoma y pasos para reproducir

Con el celular en modo "PC local" (`ServerSettingsView` → apuntar por LAN al
local-backend de la PC), en "Subir" se puede navegar la cola con las flechas
◀️▶️ y se ve el nombre del archivo, pero no hay forma de VER el video antes
de publicar — no hay miniatura ni reproductor.

### Investigación

`PCLocalPublishView.swift` (agregado 2026-08-15, versión simplificada
declarada a propósito en su propio comentario) reemplaza a `UploadView`
entera en este modo. `PCLocalPlatformFormsView` solo muestra
`video.fileName`+duración como texto — nunca pide thumbnail ni ofrece un
player, a diferencia de `PublishFormView` (modo on-device/Nube), que sí
tiene `LocalVideoPlayerView` vía `fullScreenCover`.

El local-backend ya expone lo necesario, sin nada nuevo del lado servidor:
`GET /api/videos/stream/:id` (`local-backend/src/routes/stream.routes.ts:8`)
y `GET /api/videos/:fileId/thumbnail` (`local-backend/src/routes/video.routes.ts:22`)
— mismo contrato que ya usa `RemoteLibraryAPI.streamURL`/`LocalVideoPlayerView`
en el resto de la app.

### Corrección

Sin implementar. Plan completo (iOS + Android, incluye además el gap
hermano de abajo) en `UIEssePanel/PLAN_LAN_PICKER_Y_REPRODUCTOR-2026-08-18.md`
— reproductor vía `PCLocalVideoPlayerView`/`LocalVideoPlayerView` en
`fullScreenCover`, mismo patrón que `LibraryView.swift`/`PublishFormView.swift`.

### Verificación y pendiente

No implementado. No compilable desde este entorno (ver `../CLAUDE.md`).

**Gap hermano confirmado 2026-08-18** (mismo área, mismo plan de arriba): el
picker "Elegir video" del formulario de Subir (`VideoPickerView` en
`UploadView.swift`) tampoco tiene sección "Biblioteca LAN" — solo "Local" y
"Nube". Verificado leyendo el archivo completo, no hay ninguna referencia a
LAN/`canSeeLANLibrary` ahí. Un usuario en modo LAN no puede cambiar a un
video de la PC desde "Cambiar video". Cubierto por el punto 1 del plan.

### Historial
- 2026-08-16 — agente: causa raíz encontrada durante conversación con el usuario, documentada sin corregir (a la espera de prioridad).
- 2026-08-18 — usuario + agente: confirmado que sigue sin corregir (no se
  puede dar por resuelto junto con BUG-2026-08-16-02). Encontrado el gap
  hermano del picker de "Cambiar video" sin sección LAN. Armado
  `UIEssePanel/PLAN_LAN_PICKER_Y_REPRODUCTOR-2026-08-18.md` con el plan
  completo (iOS + Android) para los dos gaps.
- 2026-08-18 — agente: implementado el plan completo en los dos repos.
  **iOS**: `LANLibraryAccess.swift` (nuevo, extrae la política LAN de
  `LibraryView.swift` sin cambiar su comportamiento), `VideoPickerView`
  (`UploadView.swift`) gana sección "Biblioteca LAN", `VideoDetailView.swift`
  y `PCLocalVideoDetailView` (`PCLocalPublishView.swift`) ganan botón de
  reproducir en la miniatura. Build real vía SSH a `macgessemberg22`: exit 0,
  0 errores (incluyó registrar `LANLibraryAccess.swift` a mano en
  `project.pbxproj`, mismo patrón que `RefreshErrorBanner.swift` en
  2026-08-12). **Android**: `LanLibraryRepository.kt` (nuevo, en
  `core:network`, `@Singleton` como `LanPcDiscoveryStore`) extrae
  discovery+fetch de `LibraryViewModel.kt` sin cambiar su comportamiento;
  `UploadViewModel.kt` lo consume para exponer `canSeeLanLibrary`/
  `lanVideos`/`lanBaseUrl`; `UploadScreen.kt` gana bloque horizontal
  "Biblioteca LAN" (antes de `FileList`) que emite `onSelectLan` en vez de
  seleccionar un `VideoFile`; `EsseAnalyticsNavHost.kt` (único lugar que ve
  `feature:upload` y `feature:library` a la vez) arma el
  `LibraryListItem.LanVideo` y abre `LocalPcPublishSheet` — mismo sheet que
  ya usa Biblioteca, sin duplicarlo. `LocalPcPublishSheet.kt` gana miniatura
  tocable que abre `RemoteVideoPlayerDialog` (reuso directo, ya genérico).
  **Sin verificar por Gradle real** (bug conocido de Claude Code en Windows,
  ver `../CLAUDE.md`) — revisado línea por línea contra los tipos/DTOs reales
  y los patrones ya existentes del repo (mismo criterio que el resto de
  cambios Android de esta sesión). Pendiente: que el usuario corra
  `./gradlew assembleDebug` y confirme.

## BUG-2026-08-16-02 — Chip "Catálogo PC" (3ra fuente: local/nube/LAN) nunca aparece en mobile, en ningún tier

- Estado: `verificado` — pero **superado por una feature posterior, no solo por el fix puntual descrito abajo**. Ver nota 2026-08-18 al final del Historial antes de asumir que `canSeeBackupCatalog` sigue siendo el mecanismo real.
- Reportado: 2026-08-16
- Plataformas: iOS | Android
- Severidad: media
- Reportado por: usuario

### Síntoma y pasos para reproducir

Biblioteca remota / filtro de origen en mobile debía distinguir 3 fuentes:
local (archivo en el teléfono), Nube (bytes reales en la central) y "Catálogo
PC" (metadata de solo lectura del backup automático del escritorio, ver
`backup.controller.ts::getBackupFiles`) — el equivalente mobile a "LAN (PC
local)". El tercer chip nunca se ve, para ningún usuario, en ningún tier.

### Resultado esperado / resultado observado

Esperado: el chip "Catálogo PC" aparece para cualquier usuario premium (no
requiere el entitlement de storage aparte que sí pide "Nube"), según el
comentario ya presente en ambos archivos. Observado: el chip nunca aparece,
ni para el owner.

### Investigación

Toda la lógica de merge/filtro/fetch alrededor del chip (`visibleFilters`,
`loadRemoteSourcesIfNeeded`, el merge de `.backupCatalog` en la lista de
items) está completa y funcionando en los dos repos — coincide con lo que la
memoria de sesión daba por "implementado, casi al espejo entre plataformas".
Lo que NO estaba conectado es el gate que decide si el usuario puede verlo:

- iOS — `essenalytics-ios/Esse-Analytics/Features/Library/LibraryView.swift`
  (antes de la línea ~55): `private var canSeeBackupCatalog: Bool { false }`
  — hardcodeado, no lee `currentUser` para nada.
- Android — `essenalytics-android/feature/library/src/main/kotlin/com/esseanalytics/android/feature/library/LibraryViewModel.kt`
  (antes de la línea ~64): `val canSeeBackupCatalog: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()`
  — mismo problema, ni siquiera lee `tokenStore.authState`.

Ambos archivos ya tenían el comentario correcto de la intención ("gratis
para todo premium, requirePremium en la central, no requiere el entitlement
de storage aparte") — es decir, el placeholder se dejó puesto y nunca se
terminó de cablear a un dato real, en los dos repos por separado (no es que
uno haya copiado el bug del otro).

### Corrección

- iOS: `canSeeBackupCatalog` pasa a `currentUser?.isPremium == true` (mismo
  patrón que `canUseCloudStorage`, misma propiedad `isPremium` ya existente
  en `Core/Model/User.swift`).
- Android: `canSeeBackupCatalog` pasa a un `StateFlow` derivado de
  `tokenStore.authState.map { ... user?.isPremium == true }`, mismo patrón
  que `canUseCloudStorage` en el mismo archivo (`User.kt` ya tenía
  `isPremium` como propiedad derivada).

### Verificación y pendiente

**iOS: verificado 2026-08-16** — build real vía SSH a la Mac
(`macgessemberg22`, key `id_ed25519_macbuild`, ver memoria de sesión
`ios_ssh_build`), `xcodebuild build -scheme Esse-Analytics -destination
'generic/platform=iOS Simulator'`, exit 0, sin warnings nuevos. Commiteado a
`main` de `essenalytics-ios` (`d3af26f`), no pusheado todavía. Pendiente
real: confirmar visualmente en el simulador/dispositivo que el chip
efectivamente aparece para un usuario premium y no para uno free (el build
solo prueba que compila, no el comportamiento en runtime).

**Android: sin verificar** — Gradle no puede correr desde esta sesión de
Claude Code (bug conocido, ver `../CLAUDE.md`). Cambio sigue sin commitear
en `essenalytics-android` a propósito, a la espera de que el usuario lo
compile en Android Studio.

### Historial
- 2026-08-16 — agente: causa raíz encontrada y corregida en los dos repos, sin build real.
- 2026-08-16 — agente: iOS verificado con build real vía SSH a la Mac y commiteado a `main` (`d3af26f`). Android sigue sin commitear, a la espera del usuario.
- 2026-08-18 — agente: **este fix quedó superado, no revertido.** El chip que
  esta entrada arregla ("Catálogo PC" vía `canSeeBackupCatalog = isPremium`)
  fue reemplazado por la feature "Biblioteca LAN" completa
  (`docs/lan-library-auto-switch-design-2026-08-16.md`), con ~10 commits
  posteriores en cada repo. Confirmado en el código actual: `LibraryView.swift`
  (iOS) ya no tiene `canSeeBackupCatalog` en ningún lado — el gate real hoy es
  `canSeeLANLibrary`. Android tiene el mismo reemplazo, con comentario propio
  en el código (`LibraryViewModel.kt`: *"FIX 2026-08-17... reemplaza a
  canSeeBackupCatalog"*). El síntoma original (chip que nunca aparecía) sigue
  resuelto — por el mecanismo nuevo, no por el descrito arriba. Se deja esta
  entrada como registro histórico del hallazgo original; no editar
  "Corrección" para no perder el rastro de qué se investigó ese día.

## BUG-2026-08-16-01 — TikTok publicado dos veces de verdad al reintentar desde iOS tras una interrupción

- Estado: `investigando` — causa raíz confirmada leyendo el código (iOS +
  central), diseño de corrección completo, sin implementar todavía.
- Reportado: 2026-08-16
- Plataformas: iOS (causa raíz confirmada), Android (mismo patrón
  estructural, con mitigación parcial ya presente en su código — ver
  diagnóstico), Central (idempotencia de `recordUploadEvent`/
  `applyPlatformPublish` no alcanza a cubrir este caso)
- Severidad: alta (publicación real duplicada en TikTok, no solo un
  duplicado cosmético en Historial)
- Reportado por: usuario

### Síntoma y pasos para reproducir

Al publicar un video a TikTok desde iOS, a veces aparece 2 veces en
Historial con 2 `platformId` distintos — porque en realidad se publicaron
**2 posts reales** en TikTok, no solo 2 filas de historial duplicadas.
Reproducible (no confirmado en vivo todavía, ver "Verificación y
pendiente") cuando la app pasa a background durante el polling de status
posterior a la subida de bytes, y el usuario después usa "Reintentar
pendientes"/"Reintentar fallidas".

### Resultado esperado / resultado observado

Esperado: un reintento tras una interrupción retoma la publicación en
curso (o confirma que ya se publicó), sin generar una segunda publicación
real. Observado: cada reintento vuelve a correr el flujo completo de
`TikTokUploader.upload()` desde cero — nuevo `publish_id`, archivo
resubido entero — sin verificar si el intento anterior ya llegó a
comprometerse del lado de TikTok.

### Investigación

Causa raíz confirmada con citas archivo:línea contra el código real (iOS y
central) en
[`docs/tiktok-duplicate-publish-design-2026-08-16.md`](tiktok-duplicate-publish-design-2026-08-16.md),
sección 1. Resumen:

- `TikTokUploader.swift` (`upload()`, líneas 31-54): TikTok compromete la
  publicación en cuanto `uploadChunks()` retorna OK (línea 41) — todo lo
  que pasa después (`waitForCompletion`, líneas 168-204, hasta 5 min de
  polling) es solo observación del resultado, no una segunda confirmación
  necesaria para que el video salga público.
- `PublishFormView.swift`: `markCurrentBatchInterrupted()` (líneas
  700-712) marca como interrumpida cualquier plataforma en `.processing`
  — estado que incluye ese polling de 5 min. `retryInterrupted`/
  `retryFailed` (líneas 613-620, 660-667) llaman `publishAll()` de nuevo,
  que instancia un `TikTokUploader` nuevo desde cero (línea 1153-1155),
  sin ningún concepto de "ya había un `publish_id` en vuelo".
  `PlatformPublishState` (líneas 38-47) no tiene ningún campo para
  persistir ese `publish_id` provisorio.
- `UploadCoordinator.recordSuccess` (`UploadCoordinator.swift:12-92`) solo
  registra algo (SwiftData + central) con el resultado FINAL ya resuelto —
  no hay ningún registro intermedio de "esto está en processing" que
  sobreviva una interrupción.
- Central: `applyPlatformPublish`/`recordUploadEvent`
  (`backup.controller.ts:874-1142`) son idempotentes por
  `{userId, platform, platformId}` — no ayuda acá porque cada reintento
  genera un `platformId` real DISTINTO (son dos publicaciones de verdad,
  no un bug de idempotencia de Mongo).
- El token de TikTok vive en la central (confirmado:
  `local-backend/tiktok-upload.controller.ts:17-26` lo pide vía
  `GET /api/tiktok/token`; `backend/tiktok-upload.controller.ts:51-65`,
  `getValidToken(userId)` no depende de nada del request HTTP en curso) —
  la central ya puede, hoy, resolver el estado de un `publish_id` sin
  ayuda del teléfono que publicó (de hecho ya lo hace parcialmente, ver
  `resolvePendingTikTokIds` en `sync.controller.ts:452-500`, relacionado
  con `BUG-2026-08-15-02` más abajo en este archivo).
- Es un patrón específico de TikTok (no de YouTube/Instagram) por una
  razón estructural de su API: separa "publicar" (implícito en
  `init`+chunks) de "informar el resultado" (polling largo posterior). Ver
  comparación completa en la sección 1.5 del documento de diseño.
- Android (`TiktokUploader.kt:54-60`) ya tiene un comentario explícito
  reconociendo este mismo riesgo, con una mitigación parcial
  (`retryable = false` tras comprometer los bytes, para que WorkManager no
  reintente solo) — pero un reintento MANUAL del usuario sigue teniendo el
  mismo bug de fondo (resube desde cero, sin persistir el `publish_id`
  entre intentos).

### Corrección

No implementada — este incidente documenta el diagnóstico y el diseño de
corrección, no un fix. Plan completo (evitar la doble publicación real
persistiendo el `publish_id` apenas terminan los chunks + cambiar
"reintentar" por "resumir"; reconciliación desacoplada del dispositivo vía
job periódico en la central; migración de `platformId` provisorio a final
sin re-keying destructivo) en
[`docs/tiktok-duplicate-publish-design-2026-08-16.md`](tiktok-duplicate-publish-design-2026-08-16.md),
secciones 2-4, con plan de implementación por fases en la sección 6.

### Verificación y pendiente

- Causa raíz verificada por lectura de código, no por reproducción en vivo
  todavía — pendiente confirmar con una publicación real interrumpida a
  propósito (forzar background durante el polling de TikTok) una vez
  exista el fix, o antes si se quiere confirmar el bug tal cual está hoy.
- Todo el trabajo de la Fase 2 del plan (iOS) requiere build real en
  Xcode para verificarse — no se puede compilar Swift desde este entorno
  (Windows, ver `UIEssePanel/CLAUDE.md`); usar el acceso SSH a
  `macgessemberg22` (memoria de sesión `ios_ssh_build`) o pedirle al
  usuario que compile.
- La Fase 3 (Android, mencionada solo como paridad, no diseñada en
  detalle) tiene el mismo problema de build desde este entorno (Gradle/JVM
  en Windows, ver `UIEssePanel/CLAUDE.md`).
- La Fase 0/1 (central) sí se pueden implementar y probar end-to-end desde
  este entorno (`backend/` compila y corre normal en Windows).

### Historial
- 2026-08-16 — Claude: diagnóstico + diseño completo, sin implementar
  (tarea explícita de solo investigación/diseño).

## BUG-2026-08-15-08 — recordUploadEvent (local-backend) escribía en SQLite local pero nunca reenviaba a la central

- Estado: `corregido`.
- Reportado: 2026-08-15
- Plataformas: Local-backend, iOS/Android en modo "PC local"
- Severidad: alta -- explica el caso real y concreto que motivó BUG-2026-08-15-06/07
- Reportado por: usuario (diagnóstico preciso, con el flujo completo iOS→PC local→central)

### Diagnóstico (confirmado, no hipótesis)

Recorrido real de la publicación de "final - peores windows.mp4" en
Instagram, con el selector de servidor nuevo (ver PLAN de esa feature)
apuntando a "PC local":

```
iOS → Instagram: publicación real, exitosa
iOS → SyncAPI.recordPublish() → POST /api/sync/record-publish
   → CentralAPI.baseURL era "PC local" (local-backend), NO la central
   → local-backend::recordUploadEvent (agregado esa misma mañana, BUG-2026-08-15-07)
       → escribe en platform_videos/files de SQLite local
       → responde 200 OK
       → NUNCA reenvía nada a la central
central: nunca se entera de este evento puntual
```

Como iOS recibió `200 OK`, no hubo ningún motivo para reintentar del lado
del cliente -- el fallo era 100% invisible, ni siquiera un error que
mostrarle al usuario. Explica por completo por qué Electron mostraba todo
bien (lee su SQLite) mientras web/Android/el mismo iPhone en modo Central no
veían nada de esto.

No contradice el resto de lo encontrado hoy: `PlatformVideoModel` en la
central sí tenía datos reales de este video por otro camino (probablemente
sync/matching manual en algún momento de la sesión), pero el evento de
historial puntual de ESTA publicación específica jamás llegó orgánicamente.

### Corrección

`local-backend/src/controllers/sync.controller.ts::recordUploadEvent`
ahora, además de escribir en SQLite local:
1. Encola el evento en `history_outbox` (la misma tabla/mecanismo de
   BUG-2026-08-15-07 -- un solo outbox para los dos flujos: el de
   Electron subiendo directo, y el de un cliente reportando una
   publicación externa).
2. Intenta reenviarlo a la central de una, reusando el mismo
   `Authorization` que ya validó `verifyToken` en este request --
   `JWT_SECRET` es compartido entre `local-backend` y la central (el login
   siempre pasa por la central, que lo emite), así que el token sirve tal
   cual, sin pedir uno nuevo ni loguear de nuevo.
3. Si el reenvío falla, queda `pending` en el mismo outbox -- se reintenta
   en el próximo `pushFilesToCloudInBackground` o al arrancar el server,
   igual que cualquier otro evento pendiente.

### Verificación y pendiente

- `npx tsc --noEmit`: 48 errores, mismo baseline, ninguno nuevo.
- Pendiente: repetir el escenario real (publicar desde iOS en modo "PC
  local") y confirmar que el evento llega a la central sin intervención
  manual, sin necesitar otro backfill.

### Historial
- 2026-08-15 — Claude: causa exacta confirmada por el usuario (flujo
  completo iOS→PC local→central), verificada leyendo el código propio
  agregado esa misma mañana, corregida reusando el outbox de
  BUG-2026-08-15-07.

## BUG-2026-08-15-07 — reportUploadEvent perdía el evento en silencio si fallaba el POST a la central (sin reintento, sin registro)

- Estado: `corregido`; pendiente verificar en un fallo real (red caída / token vencido en el momento de publicar).
- Reportado: 2026-08-15
- Plataformas: Local-backend, Web/iOS/Android (consumidores del historial)
- Severidad: alta (causa de fondo real, aunque no explique BUG-2026-08-15-06 puntualmente -- ver ese incidente)
- Reportado por: usuario (con análisis de otra sesión/agente)

### Diagnóstico

`local-backend/src/services/upload-history.service.ts::reportUploadEvent`
reportaba el evento de publicación a la central (`POST /api/sync/history`)
como "best-effort" puro: si el fetch fallaba (red, token vencido, la central
caída, cualquier HTTP no-2xx), solo hacía `console.warn` y el evento se
perdía **para siempre**, sin quedar registrado en ningún lado ni
reintentarse. Los 3 uploaders (`youtube/instagram/tiktok-upload.controller.ts`)
dependen de esta única llamada.

Síntoma resultante: Electron queda "correcto" (lee su propia SQLite,
`platform_videos`, que sí se actualiza en el mismo request de subida) pero
web/iOS/Android -- que dependen de `UploadHistoryModel` en la central --
nunca se enteran, sin ningún error visible en ningún lado. El respaldo
posterior (`pushFilesToCloudInBackground`/`bulkUpsertBackupFiles`) tampoco
lo repara: sincroniza catálogo y links, pero nunca crea el registro de
historial.

**Nota importante**: se verificó a fondo (ver BUG-2026-08-15-06) que este
bug NO explica por sí solo el síntoma puntual de esa fecha -- el archivo
que se investigaba ahí ("final - peores windows.mp4") sí llegó a
`UploadHistoryModel` (vía el backfill de BUG-2026-08-15-05, no
orgánicamente). Este es un defecto real y de fondo, confirmado leyendo el
código, pero la causa exacta de BUG-2026-08-15-06 sigue sin cerrar.

**ACTUALIZACIÓN, mismo día -- segundo bug real encontrado en el propio
código de hoy**: el usuario señaló el caso exacto -- la publicación de
"peores windows" se hizo desde **iOS con el selector de servidor nuevo
apuntando a "PC local"** (ver BUG-2026-08-15-08 más abajo). iOS publicó
directo a Instagram y llamó a `SyncAPI.recordPublish()` -- pero como
`CentralAPI.baseURL` era el local-backend, no la central, ese POST llegó al
`recordUploadEvent` que se había agregado ESTA MISMA MAÑANA (más arriba en
este mismo incidente) para cerrar el 404. Ese endpoint nuevo escribía en la
SQLite local y respondía `200 OK` -- pero **nunca reenviaba nada a la
central**, así que desde la perspectiva de iOS la publicación "ya se
reportó bien" y nunca reintentó. Ver BUG-2026-08-15-08 para el fix completo
(mismo outbox, aplicado también a este endpoint).

### Corrección

**Outbox persistente en SQLite** (`local-backend`):
- Tabla nueva `history_outbox` (`src/db/database.ts`), con estado
  `pending`/`delivered`/`failed` y contador de intentos.
- `src/db/history-outbox.repo.ts`: CRUD (`enqueue`, `findPending`,
  `markDelivered`, `markRetry`, `markPermanentlyFailed`).
- `src/services/history-outbox.service.ts::flushHistoryOutbox`: intenta
  entregar todo lo `pending`, best-effort por fila (una que falla no bloquea
  al resto). 4xx que no sea 401/429 se marca `failed` (no se reintenta por
  siempre algo que la central va a rechazar siempre); todo lo demás
  (network error, 5xx, 401, 429) queda `pending` para el próximo intento.
- `reportUploadEvent` ahora encola SIEMPRE antes de intentar la entrega
  inmediata -- si falla, el evento ya está persistido, no se pierde.
- Disparadores del reintento (sin sumar un `setInterval` nuevo, reusando los
  puntos que ya existen para "algo cambió, sincronizá"):
  - `pushFilesToCloudInBackground` (cada publicación/edición de link).
  - Arranque del server (`server.ts`), usando el token cacheado del owner
    (`configRepo.get('owner_token')`) -- cubre el caso de haber cerrado la
    app con algo pendiente sin ninguna acción nueva que lo dispare.
- `GET /api/local/health` ahora expone `pendingHistoryEvents` -- el
  frontend ya pega ese endpoint en cada carga (`useBackendType.ts`), así que
  no hace falta un poll nuevo.
- **Frontend** (`App.tsx`): banner "N publicaciones pendientes de
  sincronizar con la nube — se reintentan solas" cuando `isLocal &&
  pendingHistoryEvents > 0` -- mismo patrón visual que el banner de
  Laboratorio/Modo remoto que ya existían, en vez de ocultar el fallo como
  antes.

### Verificación y pendiente

- `local-backend`: `npx tsc --noEmit` -- 48 errores, mismo baseline que
  `main`, ninguno nuevo.
- `frontend`: `npm run build` -- compila limpio.
- Pendiente: probar un fallo real (cortar red o vencer el token a mano
  durante una subida) y confirmar que el evento queda `pending`, el banner
  aparece, y se entrega solo en el próximo push/reinicio.
- No implementado: retry con backoff exponencial (hoy reintenta en cada
  disparador sin esperar más tiempo entre intentos fallidos consecutivos) --
  aceptable por ahora porque los disparadores ya son poco frecuentes
  (publicar, arrancar la app), no un loop ajustado.

### Historial
- 2026-08-15 — Claude: diagnóstico verificado leyendo el código citado por
  el usuario/otra sesión, confirmado exacto. Implementado outbox completo
  (tabla + reintento automático + indicador visual), verificado por
  compilación en los 2 paquetes.

## BUG-2026-08-15-06 — Web (modo remoto) sigue mostrando "clip - enemigos tiene.mp4" como último publicado pese a que la central tiene el dato correcto verificado

- Estado: `corregido` — causa raíz confirmada en vivo contra el endpoint real de producción, código corregido en central e iOS. Pendiente: deploy de la central (el fix de código no está corriendo todavía en `api.esse-analytics.com`) y build/instalación real de iOS.
- Reportado: 2026-08-15
- Plataformas: Web (esse-analytics.com, modo remoto). iOS ya tiene su fix
  aparte (ver BUG-2026-08-15-05, historial 2026-08-15), pendiente de
  build/instalación real en el dispositivo -- no confundir los dos.
- Severidad: alta (tarjeta principal del Dashboard)
- Reportado por: usuario

### Síntoma

En `esse-analytics.com` (modo remoto, banner amarillo "Modo remoto —
funciones limitadas" visible), la tarjeta "Último video publicado" muestra
**"clip - enemigos tiene.mp4"** (Instagram, 153 vistas / 3 likes / 1
comentario, "Publicado sáb, 25 abr") -- screenshot real adjuntado por el
usuario en el chat de esta sesión. El video correcto según el historial ya
arreglado en Mongo es **"final - peores windows.mp4"** (Instagram, hoy
2026-08-15 11:11).

Los números mostrados (153/3/1) son datos REALES y correctos -- son las
métricas reales de "enemigos tiene" (correctas, arregladas hoy mismo con la
fecha real de la API de Instagram, ver historial de BUG-2026-08-15-02/04).
El problema no es que el dato esté mal: es que se muestra el video
equivocado, con sus propios datos correctos.

### Todo lo que YA se descartó, con evidencia (no repetir esta investigación)

1. **No es un problema de datos en Mongo.** Verificado repetidas veces,
   la última justo antes de este reporte: `UploadHistoryModel` para
   `userId=6a3794fb81e6fb54aca72461` (username `esse`, confirmado -- es el
   único user con ese username, sin ambigüedad) tiene 150 registros, el
   `.find({userId}).sort({publishedAt:-1, createdAt:-1}).limit(5)` (query
   EXACTA de `getUploadHistory`, `backend/src/controllers/backup.controller.ts:1140`)
   devuelve "final - peores windows.mp4" en el puesto #1. El registro de
   "enemigos tiene" en esa misma colección tiene su `publishedAt` correcto
   en abril (`2026-04-26T04:34:20Z`), no fue tocado por nada después del
   backfill.
2. **No es un problema del proceso corriendo.** La central real corre en
   una Mac (`macgessemberg22` por SSH, ver [[ios_ssh_build]] para el acceso),
   proceso `tsx watch src/server.ts` en
   `/Volumes/Almacenamiento externo samsung/proyecto/esse-analytics/backend/`
   (⚠️ checkout DISTINTO a `/Users/gessemberg/builds/content-automation-dashboard`,
   que existe pero está vacío/sin usar -- no confundir los dos si se vuelve a
   tocar esa Mac). Confirmado: mismo remote git (`gessex22/esse-analytics`),
   `HEAD` en el último commit pusheado hoy, `git status` limpio. Mismo
   `MONGO_URI` (`cluster0.elkjyvb.mongodb.net/renders_manager`) que se usó en
   todos los scripts de verificación/backfill de esta sesión.
3. **El túnel está vivo y respondiendo.** `curl https://api.esse-analytics.com/api/health`
   → `{"ok":true,"mongoState":1}`, probado en el momento de escribir esto.
4. **El frontend apunta a la URL correcta.** `frontend/src/config.ts::API_BASE`
   = `https://api.esse-analytics.com` cuando `isCloudflarePages` (el caso de
   la web pública) -- mismo endpoint que se verificó vivo en el punto 3.
5. **No es caché del navegador.** Probado por el usuario en ventana de
   incógnito (sin extensiones, sin caché, sin Service Worker previo) -- mismo
   resultado.
6. **No es un problema de `confirmLink`/`applyPlatformPublish` para ESTE
   video puntual.** Ambos archivos ("enemigos tiene" y "peores windows")
   tienen sus registros correctos y completos en `PlatformVideoModel` y
   `FileModel` -- ya verificado en detalle en incidentes anteriores de hoy.
7. **El código de `getUploadHistory` (central) no se tocó en ningún fix de
   hoy** -- siempre fue `.find({userId, platform?}).sort({publishedAt:-1,
   createdAt:-1})`, sin filtros adicionales, confirmado leyendo el archivo
   completo dos veces.
8. **El código de `DashboardView.tsx` (frontend web) tampoco se tocó hoy** --
   se leyó completo (`load()`, el cálculo de `item`/`matchedHistory`/
   `fallbackStats`) y la lógica se ve correcta: sí resetea `fallbackStats`
   correctamente a diferencia del bug que SÍ se encontró y arregló en iOS
   (ver más abajo), no debería tener el mismo problema.

### Lo que SÍ se encontró y arregló en el camino (relacionado pero no la causa de este síntoma en la web)

- **iOS**: `DashboardView.swift::latestForDisplay` tenía un fallback que
  devolvía `fallbackStats` viejo sin validar que coincidiera con el
  historial actual -- corregido y pusheado (`essenalytics-ios` commit
  `1a7699b`), build real verificado, **pero nunca instalado en el
  dispositivo del usuario** (falta abrir Xcode y correr). Si se retoma este
  bug, primero confirmar que el usuario ya instaló ese build antes de asumir
  que el problema de iOS sigue vivo.
- **`local-backend` no tenía `POST /api/sync/history`** -- agregado hoy
  (`content-automation-dashboard` commit `e3b74eb`), cierra el gap para
  publicaciones futuras hechas desde el celular en modo "PC local", pero
  **no es la causa de este síntoma** (el síntoma es en modo remoto/web,
  hablando con la central directo, no con `local-backend`).
- **`UploadHistoryModel` estaba vacío para toda la cuenta** -- backfileado
  (150 registros, ver BUG-2026-08-15-05). Confirmado que sigue así de bien
  varias veces durante esta misma investigación.

### Hipótesis sin probar (por dónde seguir)

1. **¿Hay una segunda instancia de la central corriendo en algún lado** (otro
   proceso, otra Mac, un deploy en la nube tipo Render/Fly.io/Railway) que
   también resuelva `api.esse-analytics.com` o que el Cloudflare Tunnel esté
   apuntando a un target distinto del proceso que se inspeccionó por SSH?
   Vale la pena revisar la config del túnel (`cloudflared`, en la Mac) para
   confirmar que apunta al puerto/proceso correcto, no asumirlo.
2. **¿El navegador está resolviendo `api.esse-analytics.com` a una IP
   vieja/cacheada por DNS?** Un `nslookup`/`dig` desde la máquina del usuario
   (no desde acá) descartaría esto.
3. **¿Hay algo en el response real (no solo en Mongo) que difiera?** Sería
   ideal capturar la respuesta real de
   `GET https://api.esse-analytics.com/api/sync/history?limit=1` con el JWT
   real del usuario (Network tab del navegador, o `curl` con el token
   copiado de ahí) -- esto no se pudo hacer desde esta sesión por no tener
   credenciales, y es probablemente el paso más directo para partir en dos
   la investigación: si el response YA trae "enemigos tiene", el problema es
   100% servidor (algo no visto en los puntos 1-8 de arriba); si trae
   "peores windows" pero la UI muestra "enemigos", el problema es 100%
   frontend (un bug no encontrado en la lectura de `DashboardView.tsx`).
4. Confirmar con el usuario si en algún momento **actualizó `esse_local.db`
   o corrió algo que pudiera haber generado un registro NUEVO de "enemigos"
   en Mongo con un `publishedAt` más reciente** después del último chequeo
   de esta sesión -- se verificó "ahora mismo" en el momento de escribir
   esto, pero el estado puede seguir cambiando si hay procesos automáticos
   corriendo.

### Causa raíz definitiva (encontrada tras el handoff)

Se ejecutó el punto 3 de las hipótesis pendientes: en vez de pedirle al
usuario el JWT del navegador (**nunca compartido, por diseño** — se generó
uno propio firmado con el mismo `JWT_SECRET` que ya comparten
`local-backend`/`backend`, usando el payload exacto de `auth.controller.ts`),
se le pegó directo a `GET https://api.esse-analytics.com/api/sync/history?limit=1`
en producción real. El response **SÍ traía "clip - enemigos tiene.mp4"**
como primer ítem, con `publishedAt` = el momento exacto de la request menos
segundos — confirmando que el problema era 100% servidor/datos, no frontend
(descarta el punto 3 tal como estaba planteado).

El documento real en Mongo (`upload_history`, no `uploadhistories` —
colección con guion bajo, ojo con el nombre al escribir scripts de
diagnóstico) tenía `publishedAt` prácticamente igual a `createdAt`
(diferencia de milisegundos) — la firma clásica de "se guardó `new Date()`
en vez de una fecha real". Y **esto ya se había corregido a mano una vez
hoy** (ver BUG-2026-08-15-04) pero volvió a aparecer con fecha de "hoy"
horas después — dos veces, de hecho: la segunda vez le tocó a
"final - peores windows.mp4" (el video que SÍ era el correcto), con un
nuevo registro `publishedAt` = "ahora mismo" mientras se investigaba.

La causa tiene dos partes, una en cada capa:

1. **`recordUploadEvent` (`backend/src/controllers/backup.controller.ts`)
   nunca dejaba correr el fetch best-effort de fecha real que se agregó en
   BUG-2026-08-15-04.** Calculaba su propio `new Date()` como fallback ANTES
   de llamar a `applyPlatformPublish` (`const publishedAtDate = publishedAt
   ? new Date(publishedAt) : new Date()`), así que ese valor SIEMPRE llegaba
   truthy — el `if (!publishedAtDate)` dentro de `applyPlatformPublish` que
   dispara el fetch a la API real nunca se ejecutaba para este endpoint (que
   es el que usan iOS/Android). Además, tanto `UploadHistoryModel` como
   `PlatformVideoModel` escribían `publishedAt` con `$set` en cada llamada
   — sin protección de idempotencia, cualquier reintento (el retry de 3
   intentos de `SyncAPI.recordPublish` en iOS, o un segundo click del mismo
   flujo) volvía a pisar una fecha ya correcta con "ahora".

2. **iOS mandaba `Date()`/la fecha de creación local como si fuera la fecha
   real de publicación, en 3 lugares distintos**, cada uno alimentando el
   bug de arriba con datos malos:
   - `SettingsView.swift::syncPlatformHistory` (backfill retroactivo de
     links locales que la central no conoce todavía) mandaba
     `entity.publishedAt ?? entity.createdAt` — `entity.createdAt` es
     cuándo se creó la FILA en SwiftData, no una fecha de publicación real.
     Para un link que la central ve por primera vez, esa fila se crea HOY
     -- **este es el botón que efectivamente disparó los dos incidentes de
     hoy** (confirmado: los dos registros corruptos tenían `source: "ios"`,
     coincidiendo con el uso de este flujo durante la sesión).
   - `VideoDetailView.swift::saveLink` (pegar un link a mano para un badge
     histórico) mandaba `Date()` sin condición para un link nuevo.

### Corrección

- `applyPlatformPublish` ahora devuelve la fecha que efectivamente resolvió
  (`{ linkedFileId, publishedAt }`), y `PlatformVideoModel`/`UploadHistoryModel`
  escriben `publishedAt` en `$setOnInsert` en vez de `$set` — una vez fijado
  para un `platform+platformId`, un reintento posterior ya no puede pisarlo.
- `recordUploadEvent` ya no calcula su propio fallback antes de llamar a
  `applyPlatformPublish` — le pasa `undefined` cuando el caller no manda
  `publishedAt`, dejando que el fetch best-effort a la API real (BUG-04)
  se ejecute de verdad, y usa la fecha resuelta también para `UploadHistoryModel`.
- iOS: `SyncAPI.recordPublish`/`RecordPublishRequest.publishedAt` pasa a
  `Date?` (antes no-opcional). `syncPlatformHistory` manda
  `entity.publishedAt` tal cual (nil si nunca se guardó una, en vez de
  adivinar con `createdAt`). `VideoDetailView.saveLink` separa la fecha
  local (siempre concreta, para SwiftData) de la fecha reportada a la
  central (nil para un link nuevo).
- **Dato corrupto de "clip - enemigos tiene.mp4" corregido a mano en Mongo**
  (`upload_history` + `platformvideos`, `publishedAt` → `2026-04-26T04:34:20Z`,
  la fecha real ya confirmada en BUG-04) y reverificado contra el mismo
  endpoint real — el response pasó a traer "final - peores windows.mp4"
  como primer ítem (aunque ese registro puntual también tenía `publishedAt`
  de "ahora" en el momento del re-chequeo, por el mismo bug corriendo con el
  código viejo; se corrige solo una vez el fix de `backend` esté deployado).

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/`: mismo baseline de 27 errores
  preexistentes, ninguno nuevo. iOS **no compilado en esta sesión** (sin
  Xcode/macOS en este entorno) — pendiente build real vía SSH a la Mac antes
  de instalar.
- **Pendiente crítico: el fix de `backend/src/controllers/backup.controller.ts`
  todavía no está deployado en el proceso real detrás de `api.esse-analytics.com`**
  — hasta que no se reinicie ese proceso con el código nuevo, `recordUploadEvent`
  sigue sin el fetch best-effort y cualquier llamada sin `publishedAt` (o el
  botón de iOS mientras no se instale el build nuevo) puede seguir generando
  el mismo síntoma.
- Pendiente: probar `syncPlatformHistory` con un link histórico real tras
  el deploy de central + build de iOS, confirmando que `publishedAt` queda
  con la fecha real (o al menos no con la de hoy) en vez de repetir el bug.

### Historial
- 2026-08-15 — Claude: investigación extensa, causa NO encontrada pese a
  descartar sistemáticamente datos/proceso/túnel/config/caché/código
  conocido. Handoff a otra sesión con el punto 3 de las hipótesis (capturar
  el response real con curl+JWT) como paso más directo para continuar.
- 2026-08-15 — Claude: causa raíz definitiva encontrada minando un JWT
  propio (mismo `JWT_SECRET` compartido, nunca se usó ni se pidió el token
  real del usuario) y pegándole en vivo al endpoint real de producción.
  Corregido en `backend` (recordUploadEvent/applyPlatformPublish, `tsc`
  limpio) y en iOS (3 sitios que mandaban una fecha adivinada). Dato
  corrupto corregido a mano en Mongo. Deploy de central e instalación de
  iOS quedan pendientes.

## BUG-2026-08-15-05 — Dashboard mostraba el video equivocado como "último publicado" (Historial vacío desde siempre)

- Estado: `corregido`; backfill aplicado, pendiente verificar Dashboard en los 3 clientes.
- Reportado: 2026-08-15
- Plataformas: Central, iOS, Android, Web, Local-backend (PC local)
- Severidad: alta (afecta la tarjeta principal del Dashboard en todos los clientes)
- Reportado por: usuario

### Síntoma y pasos para reproducir

El Dashboard ("Último video publicado") mostraba un video que no era el más
recientemente publicado -- confirmado con "final - peores windows.mp4"
apareciendo como "último" en vez del real más reciente.

### Investigación

`UploadHistoryModel` (central) tenía **0 documentos en toda la cuenta**,
pese a tener 150 `PlatformVideoModel` reales con links/métricas. Causa: la
mayoría de las publicaciones de esta cuenta se resolvieron con "Editar
links"/match manual (`confirmLink` en `sync.controller.ts`), que actualiza
`PlatformVideoModel`/`FileModel` vía `applyPlatformPublish` pero **nunca
escribía en `UploadHistoryModel`** -- a diferencia de `recordUploadEvent`
(subida en vivo desde la app), que sí lo hace. Con el historial siempre
vacío, el Dashboard (iOS/Android/web) cae a su fallback documentado ("sin
historial, mostrar el primero de `group-stats`", ordenado por
`fecha_creacion` -- la fecha de CREACIÓN del archivo, no de publicación),
mostrando casi cualquier cosa menos lo realmente más reciente.

De paso, investigando por qué un video publicado desde el celular en modo
"PC local" tampoco aparecía: **`local-backend` no tenía ningún `POST
/api/sync/history` ni `/api/sync/record-publish`** -- sin ese endpoint, un
cliente apuntando a la LAN de la PC en vez de a la central no tiene dónde
reportar una publicación (404 mudo, best-effort, no rompe la subida en sí
pero tampoco queda registrada en ningún lado).

### Corrección

1. **Backfill** (`backend`, corrido a mano en Mongo): un `UploadHistoryModel`
   por cada `PlatformVideoModel` real+vinculado existente (150 registros
   creados), usando sus propios `publishedAt`/`platformUrl`/etc. Corrige el
   síntoma actual de inmediato en todos los clientes que leen de la central.
2. **`confirmLink`** (`backend/src/controllers/sync.controller.ts`) ahora
   también escribe en `UploadHistoryModel` (mismo patrón `upsert` que
   `recordUploadEvent`), para que esto no vuelva a pasar con futuros matches
   manuales.
3. **`recordUploadEvent` nuevo en `local-backend`**
   (`src/controllers/sync.controller.ts` + `src/routes/sync.routes.ts`,
   `POST /api/sync/history` y alias `/api/sync/record-publish`) -- mismo
   contrato que la central, pero escribe en la SQLite de la PC
   (`platform_videos` + `files.platforms`), resolviendo el archivo por
   `content_id`/`file_name` ya que el celular no conoce el id local.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/` (27) y `local-backend/` (48): mismo
  conteo de errores preexistentes en ambos, ninguno nuevo.
- Backfill verificado: 150/150 insertados, top 3 por `publishedAt` desc ya
  muestra el orden real correcto.
- Pendiente: confirmar visualmente que el Dashboard de iOS/Android/web ya
  muestra el video correcto tras el backfill, y probar el flujo completo
  (celular en modo PC local publicando algo nuevo) para confirmar que
  `local-backend` ahora sí lo registra.

### Historial
- 2026-08-15 — Claude: causa raíz encontrada (historial global vacío, no un
  problema puntual de "PC local"), backfill aplicado, 2 fixes de código para
  que no vuelva a pasar.
- 2026-08-15 — Claude: tras el backfill, el usuario reportó que el Dashboard
  de iOS seguía mostrando "clip - enemigos tiene.mp4" en vez del correcto.
  Causa DISTINTA, del lado cliente: `DashboardView.swift::latestForDisplay`
  tenía un segundo `if let fallbackStats { return fallbackStats }` SIN el
  chequeo `fallbackMatchesLatestHistory` (a diferencia del primero) --
  `fallbackStats` es deliberadamente persistente entre refreshes, así que
  cuando `latest` fallaba en encontrar el archivo del historial YA correcto
  dentro de `items` (afuera del top-5 de `group-stats` por `fecha_creacion`
  vieja), esa línea servía sin darse cuenta datos STALE de un video previo
  completamente distinto. Corregido: se saca esa línea, cae al placeholder
  honesto (nombre + sin métricas) en vez de datos de otro video. Build real
  verificado (exit 0, 0 errores).

## BUG-2026-08-15-04 — Link resuelto a mano para una publicación vieja se guardaba con fecha "hoy"

- Estado: `corregido`; pendiente de verificación con un link real que no tenga registro local previo.
- Reportado: 2026-08-15
- Plataformas: Central (afecta a los 3 clientes que llaman a `applyPlatformPublish`)
- Severidad: media (rompe el orden "más reciente" de Estadísticas por plataforma, no las métricas en sí)
- Reportado por: usuario

### Síntoma y pasos para reproducir

Al resolver un link para un video que ya estaba publicado hace tiempo en una
plataforma pero nunca tuvo un `PlatformVideoModel`/registro local (badge
huérfano, mismo patrón que BUG-2026-08-15-02/03), el `publishedAt` guardado
quedaba en el momento en que se resolvió el link ("hoy"), no la fecha real de
publicación. Caso real: Instagram de "clip - enemigos tiene.mp4", publicado
el 25/04, resuelto hoy -- quedó con `publishedAt: 2026-08-15T10:40:20Z` hasta
que se corrigió a mano contra la API real de Instagram (`timestamp:
2026-04-26T04:34:20Z`).

### Investigación

`applyPlatformPublish` (`backend/src/controllers/backup.controller.ts`)
default a `new Date()` cuando el caller no manda `publishedAt`. Ya existía una
salvaguarda parcial en `local-backend/src/controllers/video.controller.ts::
setPlatformLink` (reusar `previousPublication.published_at` si existía un
registro local previo para ese archivo+plataforma) -- pero **solo cubre la
corrección de un link ya conocido localmente**, no la primera vez que se
resuelve un badge huérfano (no hay `previousPublication` de la cual sacar la
fecha). Ya había un incidente igual documentado en un comentario del código
mismo, fechado 2026-08-14, con TikTok -- ese fix solo tapó el síntoma en el
Calendario (omitiendo la fecha ahí cuando no hay una confiable), nunca
arregló la causa en `PlatformVideoModel`/`FileModel`.

### Corrección

Tres funciones nuevas, una por plataforma, que consultan la fecha real de
publicación directo a la API (todas best-effort, `null` si falla):
- `youtube.service.ts::getVideoPublishedAt(videoId)` -- reusa
  `getVideoDetails` (ya pedía `part=snippet`, que trae `publishedAt`).
- `instagram.service.ts::getMediaPublishedAt(userId, mediaId)` -- Graph API
  `fields=timestamp`.
- `tiktok.service.ts::getVideoPublishedAt(userId, videoId)` -- mismo
  `/video/query/` que `getVideoStatsByIds`, pidiendo `create_time`.

`applyPlatformPublish` ahora, cuando el caller no manda `publishedAt`, llama
a la función correspondiente (con el `platformId` ya resuelto a su forma
numérica/real, no el shortcode/publish_id crudo) antes de caer a `new
Date()`. Si la plataforma no responde (token vencido, red, video privado), se
comporta exactamente igual que antes -- nunca bloquea el link/badge por esto.

### Verificación y pendiente

- `npx tsc --noEmit`: mismo conteo de errores preexistentes que `main` (27),
  ninguno nuevo.
- Pendiente: probar con un link real (badge huérfano, plataforma conectada
  con token válido) y confirmar que `publishedAt` queda con la fecha real, no
  la de hoy.
- No cubre el caso donde la plataforma SÍ responde pero con datos
  incompletos/erróneos (ej. Graph API sin `timestamp` en la respuesta) --
  ahí sigue cayendo a `new Date()` como antes, mismo comportamiento previo al
  fix.

### Historial
- 2026-08-15 — Claude: encontrado en vivo (usuario probando el selector de
  servidor "PC local"), causa identificada, corregido con fetch best-effort a
  la API real de cada plataforma.

## BUG-2026-08-15-03 — Estado de publicación histórico sin enlace se interpreta distinto entre Nube y móviles

- Estado: `en investigación` (central implementada y migrada 2026-08-19; label "Sin enlace" en Android/iOS -- iOS con build real verificado, Android sin build real todavía)
- Reportado: 2026-08-15
- Plataformas: Central, Nube, iOS, Android
- Severidad: alta (un mismo video puede aparecer terminado en Android y disponible en iOS)
- Reportado por: usuario

### Planteamiento del problema

Los videos históricos, publicados antes de usar EsseAnalytics o publicados por
un canal externo, deben poder marcarse como publicados sin que el usuario tenga
que conseguir y registrar un enlace de cada plataforma. En esos casos el badge
es válido, pero no existe un `platformId`/URL desde el cual consultar métricas.

Actualmente `platforms` representa a la vez «publicado» y «publicado con una
identidad verificable». Biblioteca remota puede tener badges sin `platformLinks`,
y su estado puede diferir del catálogo central/backup. Los clientes interpretan
el resultado de forma distinta:

- Android oculta de Subir un video de Nube cuando las tres plataformas están
  resueltas por badges o descartes.
- iOS parte de su catálogo local y puede mostrarlo; al abrir el formulario
  incorpora después los badges de Nube.
- Métricas solo pueden obtenerse cuando existe un `PlatformVideo` con id nativo.

Ejemplo confirmado: `clip - enemigos tiene.mp4` figura con tres badges en Nube
sin enlaces, mientras el catálogo central conserva únicamente TikTok marcado,
YouTube descartado e Instagram pendiente. Por eso se oculta en Android pero
puede listarse en iOS con badges distintos.

### Resultado esperado

Una publicación histórica sin link sigue contando como publicada y resuelta
para la cola, pero se identifica explícitamente como tal. Todos los clientes
ven el mismo estado y no intentan solicitar métricas donde no existe una
identidad de plataforma.

### Solución propuesta

1. Definir por plataforma tres estados explícitos:
   - `confirmed`: publicación con `platformId` (y URL opcional); permite link y métricas.
   - `badge_only`: publicación histórica/manual sin ID ni URL; muestra «Sin enlace / métricas no disponibles».
   - `discarded`: plataforma descartada; no se publica ni se consulta.
2. Mantener `platforms` por compatibilidad como la lista de `confirmed` y
   `badge_only`, pero guardar la procedencia/estado explícito por plataforma
   (por ejemplo, `platformPublicationStates`). No inferir `confirmed` solo por
   la presencia del badge.
3. Hacer que Nube sea la fuente de verdad para un video con `contentId` y que
   el sync propague el estado completo, no una unión acumulativa de badges.
   La unión actual no puede corregir una marca histórica equivocada.
4. Android e iOS deben usar el mismo criterio de cola: tanto `confirmed` como
   `badge_only` y `discarded` son terminales; solo `pending` es publicable.
5. El Dashboard/Estadísticas solo solicitan métricas para `confirmed`. Para
   `badge_only` deben mostrar un estado claro en lugar de ceros o un error.
6. Migrar los registros existentes sin link a `badge_only`; conservar como
   `confirmed` únicamente los que tengan `platformLinks` o `PlatformVideo`
   verificable. Los casos donde las fuentes difieren requieren una revisión
   puntual antes de sobrescribir la decisión histórica del usuario.

### Verificación propuesta

1. Crear un video histórico con tres `badge_only`: debe desaparecer de la cola
   tanto en Android como en iOS y mostrar los tres badges sin métricas.
2. Crear un video con TikTok `confirmed`, YouTube `discarded` e Instagram
   pendiente: debe seguir disponible exclusivamente para Instagram en ambos
   móviles.
3. Publicar desde iOS, Android y Desktop: el resultado debe crear
   `confirmed` con ID y mantener el mismo estado en Nube y catálogo central.

### Historial

- 2026-08-15 — Codex: causa funcional documentada; pendiente implementar el
  modelo explícito y la migración de datos.
- 2026-08-15 — Claude: verificado el ejemplo citado ("clip - enemigos tiene.mp4")
  directo en Mongo -- confirmado real (mismo `contentId`, `files` 2/3 resuelto
  vs `remote_library_videos` 3/3). Escaneada la cuenta completa por
  `contentId` compartido: 1117 videos con match entre las dos colecciones, 11
  divergentes, 8 con divergencia de cola real (`queueDivergent`: un lado
  3/3 resuelto y el otro no). Confirmado además en código que
  `applyPlatformPublish` (`backup.controller.ts`) ya trata a `FileModel`
  como fuente primaria (propaga altas de `files` → Nube, nunca al revés) y
  que **ningún camino propaga descartes en ninguna dirección** -- por eso
  las 8 divergencias son una mezcla: unas ganaron un badge en Nube que nunca
  llegó a `files`, otras se descartaron en `files` (Editar links de
  escritorio) sin llegar nunca a Nube.
  **Reconciliados los 10 registros divergentes** (los 8 + 2 menores que
  coincidían en conteo pero no en el detalle) a mano en Mongo, con `files`
  como fuente de verdad en cada uno (criterio confirmado por el usuario:
  Nube es almacenamiento dinámico/temporal, no la fuente primaria) y
  verificación antes/después por registro. Re-escaneo posterior de toda la
  cuenta: **0 divergencias restantes**.
  Esto arregla el SÍNTOMA de datos actual, no la causa -- sin propagación de
  descartes en ninguna dirección, cualquier "Editar links" en escritorio o
  cualquier descarte hecho directo en Nube desde el celular puede volver a
  divergir. La causa de fondo sigue abierta y requiere la propuesta de
  arriba (o como mínimo, propagar también los descartes en
  `applyPlatformPublish`/`updateFilePlatforms`/`RemoteLibraryAPI.updatePlatforms`).
- 2026-08-15 (commit `31737c9`, otra sesión) — propagó descartes hechos en
  Nube (`updateRemoteLibraryVideoPlatforms`) hacia `FileModel` -- resolvió
  **una** de las dos direcciones del "como mínimo" de arriba, no el modelo
  completo. La dirección inversa (`updateFilePlatforms`, descartes hechos en
  el catálogo central/mobile) seguía sin propagar a Nube hasta hoy.
- 2026-08-19 — Claude: implementado el modelo completo de la propuesta
  (pasos 1-3 de la sección de arriba), central únicamente:
  - Nuevo `platform_states`/`platformStates` (`backend/src/utils/platform-state.util.ts`,
    tipo compartido `PlatformPublicationState = 'confirmed'|'badge_only'|'discarded'`)
    en `FileModel` y `RemoteLibraryVideoModel`. Sparse a propósito.
  - `applyPlatformPublish` marca `confirmed` en ambos modelos cuando hay un
    `platformId` real -- incluye la promoción: si una plataforma ya estaba
    como `badge_only` y ahora se publica de verdad, se actualiza a
    `confirmed` (antes el código solo miraba si la plataforma YA estaba en
    el array plano, sin mirar el estado real detrás, así que esa promoción
    nunca pasaba).
  - `updateFilePlatforms` (toggle desde mobile/desktop) deriva `badge_only`/
    `discarded` sin degradar nunca algo ya `confirmed`
    (`deriveStatesFromToggle`), y ahora **también propaga sus descartes
    nuevos hacia `RemoteLibraryVideoModel`** -- cierra la dirección que
    `31737c9` había dejado pendiente, mismo criterio conservador (no pisa
    una plataforma que Nube ya tiene como badge/confirmada real).
  - `updateRemoteLibraryVideoPlatforms` deriva estados igual (confirmed si
    hay `platformLink`, si no `badge_only`/`discarded`) y su propagación de
    descartes a `FileModel` (ya existente) ahora también escribe
    `platform_states` ahí (antes solo tocaba `platforms_discarded`).
  - `getBackupFiles` expone `platform_states` en la respuesta (antes no
    estaba en el `.select()`, y el merge con `BackupFileModel` no lo
    contemplaba porque ese modelo nunca tuvo el concepto).
  - Migración `backend/scripts/mongo-platform-states-migration.js` (dry-run
    por default, `--apply` para escribir, patrón igual a los scripts
    previos de este repo): backfillea `platform_states`/`platformStates` en
    todo lo existente, derivando `confirmed` desde `PlatformVideoModel.linkedFileId`
    real (`files`) o `platformLinks` (`remote_library_videos`), el resto
    `badge_only`/`discarded` según corresponda. **Aplicada en producción
    2026-08-19**: 1125 `files` + 1119 `remote_library_videos` migrados (152
    confirmed / 3125 badge_only / 15 discarded en `files`; 36/3235/12 en
    Nube) -- 0 documentos pendientes en el postflight. Rollback documentado
    en la salida del script (`$unset`).
  - Verificado con `npx tsc --noEmit`: mismo conteo de errores preexistentes
    (27) antes y después (comparado con `git stash`), 0 nuevos.
  - **Pendiente real, no arrancado todavía**: puntos 4-6 de la propuesta —
    que Android e iOS lean `platform_states`/`platformStates` para su
    criterio de cola/métricas (hoy ambos ya usan el mismo criterio de
    "3 plataformas resueltas = terminal" sobre los arrays planos, así que la
    divergencia de cola reportada originalmente era 100% de datos, no de
    lógica -- la propagación simétrica de arriba ya la ataca de raíz) y la
    migración explícita de UI que distinga "Sin enlace" para `badge_only`.
    No tocado ningún archivo Swift/Kotlin en esta sesión.
- 2026-08-19 (mismo día, continuación) — Claude: agregado el label "Sin
  enlace" en Android/iOS, pero **sin usar el `platform_states` nuevo de la
  central** -- ambas plataformas ya tenían localmente una señal equivalente
  y más simple de plomear:
  - **Nube** (`RemoteVideoDetailView.swift` iOS, `RemoteVideoDetailSheet.kt`
    -> `VideoDetailPlatformRow` compartido Android): `platformLinks`/
    `hasLink` ya viajaban desde la central (autoridad única, no por
    dispositivo) -- solo hacía falta usarlos en el texto del chip, no en el
    ícono (que ya los usaba). Confiable de punta a punta.
  - **Catálogo local** (`VideoDetailView.swift` iOS,
    `VideoDetailSheet.kt`/`VideoDetailViewModel.kt` Android): mismo cambio
    de texto, pero la señal (`PlatformVideoEntity`/`PlatformVideo` con
    `linkedFileId`) es **local a ESE dispositivo** -- un video publicado
    desde OTRO dispositivo con link real puede seguir mostrando "Sin
    enlace" acá hasta que exista un pull explícito de `platform_states`
    hacia el catálogo local (no implementado, anotado en el código con
    referencia a este bug).
  - De paso, en Android (`VideoDetailSheet.kt`/`VideoDetailViewModel.kt`):
    encontrado y arreglado un bug latente independiente -- `hasLink` se
    calculaba como `platform in file.platforms`, tautológicamente idéntico
    a la condición `PUBLISHED` de la misma fila, así que el ícono
    `LinkOff`/label "Sin enlace" nunca se mostraba pese a que el dato real
    (`platformVideoRepository.findByLinkedFileAndPlatform`) sí existía y se
    usaba en otro lado (`existingLink`, al abrir el editor). Fix: nuevo
    `VideoDetailViewModel.linkedPlatforms(fileId): Flow<Set<Platform>>`
    (reactivo, sobre `PlatformVideoRepository.observeByFile` que ya
    existía), consumido con `collectAsState` en `VideoDetailSheet`.
  - **iOS: build real verificado 2026-08-19** por SSH a la Mac
    (`macgessemberg22`, ver memoria `ios_ssh_build`) -- `xcodebuild build
    -scheme Esse-Analytics -destination "generic/platform=iOS Simulator"`,
    exit 0, 0 errores, sin warnings nuevos en los 2 archivos tocados.
    Encontrado en el camino: el checkout de la Mac tenía ~2400 líneas sin
    commitear (`LibraryView.swift`, `VideoDetailView.swift`,
    `PCLocalPublishView.swift`, `UploadView.swift`,
    `LANLibraryAccess.swift` nuevo -- trabajo en curso de
    `PLAN_LAN_PICKER_Y_REPRODUCTOR-2026-08-18.md`) y 2 commits atrás de
    `origin/main`. Se guardó ese trabajo con `git stash push -u` (mensaje
    "wip LAN picker+player 2026-08-18, stashed before pull 2026-08-19",
    queda en `stash@{0}`, NO reaplicado -- requiere que quien seguía esa
    rama lo retome a mano, probable conflicto con lo que bajó del pull) y
    se sincronizó `main` contra `origin/main` (que ya incluía este fix,
    pusheado desde Windows) antes de compilar.
  - **Android: sin build real todavía** (sin Gradle/Android Studio
    disponible en este entorno, ver trampa de entorno en `UIEssePanel/CLAUDE.md`)
    -- verificado solo por lectura de código (tipos, balance de llaves,
    imports). Pendiente que el usuario confirme con Android Studio.

## BUG-2026-08-15-02 — TikTok: badge huérfano + platformUrl nunca se corrige tras resolver el id real

- Estado: `corregido`; pendiente de verificación con una publicación real.
- Reportado: 2026-08-15
- Plataformas: Central (afecta a los 3 clientes que la consultan)
- Severidad: alta (dos videos reales mostraban "Pendiente de datos"/link roto en TikTok)
- Reportado por: usuario

### Síntoma y pasos para reproducir

Dos casos reales encontrados en la cuenta del usuario, ambos con el último
video del Dashboard mostrando TikTok "Pendiente de datos" o con el link roto:

1. "final -raytracing de iphone.mp4" tenía el badge `tiktok` marcado en
   `FileModel.platforms` sin ningún `PlatformVideoModel` vinculado (huérfano)
   -- id, link y métricas inexistentes.
2. "final - rucos con ia.mp4" sí tenía su TikTok real vinculado (con
   `platformId` numérico correcto y métricas reales), pero `platformUrl`
   seguía apuntando al `publish_id` temporal de la operación de subir
   (`.../video/v_pub_file~v2-1...`), no al video real.

### Investigación

Caso 1: el badge no tiene forma de auto-repararse solo -- si el registro real
nunca se creó (o se perdió), no hay stats/refresco en vivo que lo traiga de
vuelta; requiere intervención manual con el link real del video.

Caso 2 es un bug de código real y reproducible para CUALQUIER TikTok futuro
que tarde en resolver: `tiktok-upload.controller.ts` arma `platformId` y
`platformUrl` con el `publish_id` crudo cuando TikTok no devuelve el id real
(`publicaly_available_post_id`) dentro de la ventana de polling de 5 minutos
al publicar. `resolvePendingTikTokIds` (sync.controller.ts) reintenta resolver
el id real en cada refresco de stats y sí lo corrige en `PlatformVideoModel`
y `UploadHistoryModel` -- pero **solo el campo `platformId`, nunca
`platformUrl`**. Tampoco `getFileStats`/`getGroupStats` tocan `platformUrl`
en su refresco en vivo (su `bulkOps.$set` solo escribe
`views/likes/comments/thumbnail`). Resultado: el video queda con stats
funcionando pero el link roto **para siempre**, sin ningún camino de
auto-corrección.

### Corrección

- Datos: los dos registros puntuales de la cuenta del usuario corregidos a
  mano en Mongo (vinculación real vía `applyPlatformPublish` para el caso 1,
  `platformUrl` reconstruida para el caso 2), con verificación antes/después
  de cada mutación.
- Código: `resolvePendingTikTokIds` (`backend/src/controllers/sync.controller.ts`)
  ahora reconstruye y persiste también `platformUrl`
  (`https://www.tiktok.com/@{open_id}/video/{id resuelto}`, mismo patrón que
  usa `tiktok-upload.controller.ts` al publicar) en el mismo momento que
  corrige `platformId`, en `PlatformVideoModel` y `UploadHistoryModel`. Esto
  arregla el caso 2 hacia adelante para cualquier publicación futura que
  tarde en resolver, sin intervención manual.

### Verificación y pendiente

- `npx tsc --noEmit` en `backend/`: mismo conteo de errores preexistentes que
  en `main` (27, ninguno nuevo introducido por este cambio) -- el proyecto no
  tiene typecheck limpio en CI, no es una regresión.
- Pendiente: confirmar en producción con una publicación de TikTok real que
  tarde en resolver (`publicaly_available_post_id` fuera de la ventana de 5
  min) que `platformUrl` queda corregida en el siguiente refresco de stats.
- No cubre el caso 1 (badge huérfano) de forma genérica -- si vuelve a
  aparecer un badge sin `PlatformVideoModel` real detrás, sigue requiriendo
  diagnóstico e intervención manual como esta vez.

### Historial
- 2026-08-15 — Claude: diagnóstico verificado directo en Mongo, corrección de
  datos puntual + fix de código en `resolvePendingTikTokIds`.

## BUG-2026-08-15-01 — Dashboard iOS omitía métricas de TikTok en el último video

- Estado: `corregido`; pendiente de verificación en dispositivo iOS.
- Reportado: 2026-08-15
- Plataformas: iOS, Central
- Severidad: alta (la tarjeta principal mostraba un rendimiento incompleto)
- Reportado por: usuario

### Síntoma y pasos para reproducir

Abrir Dashboard en iOS después de publicar el último video en TikTok. La
tarjeta de «Último video publicado» no mostraba las métricas de TikTok.

### Investigación

El Dashboard solo solicitaba `GET /api/sync/file-stats` cuando el último evento
no figuraba en la respuesta resumida de `group-stats`. Si el archivo sí estaba
en esa lista, iOS reutilizaba ese slot aunque fuera cacheado o incompleto para
TikTok, sin disparar el refresco puntual que consulta sus estadísticas.

### Corrección

`DashboardView` ahora pide `file-stats` siempre para el archivo del último
evento y lo prioriza únicamente cuando corresponde a ese mismo evento. La
respuesta puntual refresca las métricas de TikTok y evita que un fallback de un
video anterior se muestre durante una recarga.

### Verificación y pendiente

- Pendiente: compilar y probar en Xcode (no disponible en este entorno).
- Caso mínimo: publicar un TikTok, abrir/refrescar Dashboard y verificar
  vistas, likes y comentarios tanto en la fila TikTok como en el total.

### Historial

- 2026-08-15 — Codex: incidente registrado y flujo de carga corregido.

## BUG-2026-08-13-01 — Calendario TikTok mostraba un último video distinto de Historial

- Estado: `corregido`; pendiente de verificación en un dispositivo iOS con los datos afectados.
- Reportado: 2026-08-13
- Plataformas: iOS, Central
- Severidad: alta (el calendario mostraba una publicación equivocada)
- Reportado por: usuario

### Síntoma y pasos para reproducir

1. Abrir Calendario en iOS y revisar el último publicado para TikTok.
2. Compararlo con el primer elemento de Historial filtrado por TikTok.

El calendario mostraba `reviewers…`, aunque Historial indicaba que esa no fue
la última publicación.

### Resultado esperado / resultado observado

- Esperado: Calendario e Historial identifican la misma última publicación de
  TikTok para el usuario.
- Observado: el calendario podía conservar un título viejo cuando ambas
  publicaciones caían el mismo día. Además, una sincronización tardía podía
  guardar la fecha de recepción del servidor, no la fecha de publicación.

### Investigación

`GET /api/sync/calendar-config` compara el override de `platform_config` con
el video real de `PlatformVideoModel`, pero la comparación usaba solo
`yyyy-MM-dd` y, en empate, elegía el override. `recordUploadEvent` ya escribe
el evento real en Historial y en `PlatformVideoModel`, así que la fuente
dinámica es la correcta para el título mostrado.

### Corrección

- `backend/src/controllers/sync.controller.ts`: en empate de fecha usa la
  publicación dinámica, manteniendo el intervalo configurado manualmente.
- `backend/src/controllers/backup.controller.ts`: al actualizar el calendario
  después de publicar, persiste `publishedAt` del evento y no `new Date()`.

### Verificación y pendiente

- `git diff --check`: correcto.
- `backend`: `npx tsc --noEmit` sigue fallando por errores de tipos ya
  existentes en varios controladores; no aparecieron errores atribuibles a
  esta corrección.
- Pendiente: publicar o sincronizar un TikTok de prueba en iOS y confirmar que
  Calendario e Historial coinciden después de refrescar.

### Historial

- 2026-08-13 — Codex: incidente registrado y corrección aplicada en Central.

## BUG-2026-08-13-02 — Dashboard iOS quedaba en “cancelled” al recargar

- Estado: `corregido`; pendiente de verificación en dispositivo/simulador iOS.
- Reportado: 2026-08-13
- Plataformas: iOS
- Severidad: alta (impedía cargar la métrica del último video)
- Reportado por: usuario

### Síntoma y pasos para reproducir

1. Entrar al Dashboard de iOS.
2. Recargar mientras aún termina la carga inicial, o provocar cargas
   solapadas mediante pull-to-refresh y el refresco tras una publicación.

En ocasiones aparece una tarjeta/error `cancelled` y no carga la métrica del
último video.

### Resultado esperado / resultado observado

- Esperado: una cancelación normal de SwiftUI no se muestra como error; la
  carga más reciente conserva o muestra los datos válidos.
- Observado: una tarea HTTP cancelada llegaba al `catch` de `DashboardView` y
  podía reemplazar el estado visible con su mensaje de cancelación. Una carga
  anterior también podía terminar después de una nueva y sobrescribirla.

### Investigación

`DashboardView.load()` inicia seis solicitudes en paralelo. SwiftUI puede
cancelar una tarea al iniciar otra o al reemplazar la vista; `APIClient` envuelve
esa cancelación como `APIError.network`, que antes se presentaba al usuario.

### Corrección

- `essenalytics-ios/Esse-Analytics/Features/Dashboard/DashboardView.swift`:
  identifica cancelaciones (`CancellationError`/`URLError.cancelled`) y no las
  convierte en banner o tarjeta de error.
- Cada carga tiene un `UUID`; solo la carga activa puede modificar el estado y
  el fallback de métricas del último video.

### Verificación y pendiente

- `git diff --check`: correcto.
- Pendiente: compilar y probar en Xcode, que no está disponible en el entorno
  actual. Caso mínimo: abrir Dashboard y hacer pull-to-refresh repetido; debe
  terminar mostrando la última métrica sin `cancelled`.

### Historial

- 2026-08-13 — Codex: incidente registrado y corrección aplicada en iOS.

## BUG-2026-08-13-03 — Los videos nuevos detectados no aparecían en Videos de Electron

- Estado: `corregido`; pendiente de verificación en Electron.
- Reportado: 2026-08-13
- Plataformas: Web/Electron, local-backend
- Severidad: alta (un archivo nuevo parecía no haberse importado)
- Reportado por: usuario

### Síntoma y pasos para reproducir

1. Guardar un archivo de video compatible en la carpeta configurada para el
   watcher de Electron.
2. Abrir o actualizar la vista **Videos**.

El archivo no aparece en la lista, aunque el watcher lo detecta y crea su fila
local.

### Resultado esperado / resultado observado

- Esperado: la vista inicial muestra los videos nuevos pendientes de publicar.
- Observado: la vista pedía `content_status=parcial` por defecto. Los archivos
  recién detectados se crean como `borrador` y `sin_publicar`, por lo que el
  filtro los excluía antes de renderizarlos.

### Corrección

`frontend/src/components/VideosView.tsx` ahora pide `no_completo` por defecto:
incluye los videos nuevos sin publicar y los publicados parcialmente, pero sigue
ocultando los que ya están completos en las tres plataformas.

### Verificación y pendiente

- Pendiente: refrescar Videos en Electron después de guardar un `.mp4`, `.mov`,
  `.m4v` o `.webm` en la carpeta vigilada; debe aparecer sin activar filtros.

### Historial

- 2026-08-13 — Codex: causa identificada como filtro inicial y corrección aplicada.
