# Handoff — BUG-2026-09-05-01: descarte/precarga desde el celular no llegan "al momento" a la PC

Documento para que otro agente/dev analice en profundidad antes de tocar
código. No hay nada implementado todavía — el usuario pidió explícitamente
dejar esto como problema + opciones para revisión, no una implementación
apurada.

Bug original: [`docs/bug-reports.md`](bug-reports.md) → `BUG-2026-09-05-01`
(línea ~624). Plan de fondo relacionado (mismo mecanismo, otra queja):
[`docs/instant-matches-stats-plan-2026-08-31.md`](instant-matches-stats-plan-2026-08-31.md),
Fase 7.

## 1. Síntoma reportado por el usuario (2026-09-05)

1. Descartar una plataforma de un video desde iOS → no se ve reflejado en la
   PC (Electron) al revisarla poco después.
2. Publicar/subir un video desde el celular → la precarga a Biblioteca
   remota (Nube) no se dispara "al momento" en la PC.

Ambos pueden tardar varios minutos, o no aparecer hasta que algo puntual
dispare una sincronización en la PC.

## 2. Contexto de arquitectura (no negociable sin decisión explícita)

Modelo de datos documentado en `UIEssePanel/CLAUDE.md` y
`content-automation-dashboard/CLAUDE.md`:

- **App (SQLite local)** y **dominio (Mongo central)** son bases separadas a
  propósito — es la base del modelo de negocio freemium: el núcleo corre
  local (videos físicos + SQLite) sin costo de almacenamiento en la nube; la
  central solo maneja auth, dominio y tokens OAuth, más un "espejo" del
  catálogo.
- Un cambio hecho en iOS (descartar, publicar) escribe en la central de
  inmediato — **eso ya funciona bien, no es parte del problema**. El gap es
  que la PC (Electron) tiene su propia SQLite local, y esa SQLite solo se
  actualiza cuando la PC misma decide ir a preguntarle a la central
  (`pull`).
- Conclusión: "que todo viva directo en central" (sacar la SQLite local)
  contradice el modelo de negocio documentado a propósito. Cualquier
  solución debería mantener SQLite local como fuente de verdad de la PC y
  resolver esto por el lado de "con qué frecuencia/eventos la PC va a
  buscar lo nuevo", no cambiando dónde vive el dato.

## 3. Causa raíz (confirmada por lectura de código)

No existe ningún canal de notificación push central→Electron. La PC solo se
entera de cambios hechos en otro dispositivo cuando ella misma corre
`runSyncTick()`:

- [`frontend/src/services/syncOrchestrator.ts:16-24`](../frontend/src/services/syncOrchestrator.ts) —
  corre `push()` + `pull()` + `ensurePreload()` como una sola unidad
  best-effort, con un **cooldown compartido de 5 minutos**
  (`MIN_GAP_MS = 5 * 60 * 1000`) que aplica igual a los tres, salvo que se
  llame con `force=true`.

Disparadores actuales de ese tick
([`frontend/src/hooks/useSyncOrchestrator.ts`](../frontend/src/hooks/useSyncOrchestrator.ts)):

| Disparador | Fuerza el tick (`force=true`) | Sujeto al cooldown de 5 min |
|---|---|---|
| Montar la app (4s después) | Sí | No aplica (siempre corre la primera vez) |
| Volver a tener foco la ventana (`focus`) | No | Sí |
| Volver a estar visible la pestaña (`visibilitychange`) | No | Sí |
| Fallback periódico cada 20 min (`FALLBACK_INTERVAL_MS`) | No | Sí (pero ya espació el propio intervalo) |
| Entrar a "Videos" ([`VideosView.tsx:526`](../frontend/src/components/VideosView.tsx)) | No | Sí |
| Cerrar la app (`beforeunload`) | — | Solo dispara un `push` aislado (keepalive), no un tick completo |

Si el usuario vuelve a mirar la PC dentro de los 5 minutos del último tick
(común si la app ya estaba abierta con foco reciente), ni el `pull`
(síntoma 1: descarte) ni `ensurePreload()` (síntoma 2: precarga) vuelven a
correr — el cambio ya está "de verdad" en la central, pero la PC todavía no
fue a buscarlo.

**Dato que NO estaba en el reporte original y es relevante para decidir la
solución**: `pull()` no es una llamada liviana. En
[`local-backend/src/controllers/backup-sync.controller.ts:218` (`pullFromCloud`)](../local-backend/src/controllers/backup-sync.controller.ts)
trae **todo** el catálogo de la nube (`includeResolved=true`, sin
paginación) y por cada archivo remoto hace un lookup en SQLite local (por
`content_id` o, si no matchea, un `fileRepo.findAll` con búsqueda por
nombre como fallback) — es decir, es una reconciliación completa O(N) sobre
todo el catálogo del usuario, no una consulta incremental "qué cambió desde
la última vez". Sacarle el cooldown sin más implica correr esta
reconciliación completa cada vez que se cumple cualquiera de los
disparadores de la tabla de arriba.

**Asimetría interesante ya presente en el código**: la pestaña "Emparejar
entre plataformas" (`SyncPanel.tsx` → `syncService.getCrossMatchCandidates`,
línea ~303/318) **no pasa por `runSyncTick` en absoluto** — pega directo a
la central (vía proxy de local-backend) cada vez que se abre o pagina, sin
ningún cooldown. O sea que para "Matches" el dato ya es fresco siempre; el
cooldown solo afecta a lo que depende de la SQLite local reconciliada
(`Videos`, y lo que dependa de `ensurePreload` para Biblioteca remota).

## 4. Opciones evaluadas (sin implementar, para decidir)

### A. Fix acotado: pull sin cooldown en focus/mount/vistas relevantes
Separar el cooldown de `pull()` del de `push()`/`ensurePreload()` en
`runSyncTick`, y dejar que el pull corra siempre (o con un cooldown mucho
más chico, ej. 30s) en focus/visibilitychange/apertura de Videos. El push
(mandar cambios propios de la PC) sigue con su cooldown de 5 min para no
sobrecargar la escritura hacia la central.

- Pro: cambio chico, bajo riesgo, no toca arquitectura.
- Contra: dado el hallazgo de la sección 3, esto multiplica cuántas veces
  se corre una reconciliación O(N) completa contra Mongo — hay que medir
  cuánto pesa eso en la práctica (¿cuántos archivos tiene el catálogo real
  del usuario? Ver `central_tables_consolidation_pending` en memoria: al
  2026-09-02 eran ~1121 files, mono-tenant). También hay que revisar si el
  rate-limit de `/api` en la central (`CLAUDE.md` → backend hardening,
  `express-rate-limit`) permite esta frecuencia sin devolver 429.
- No resuelve la propagación "instantánea" real — sigue siendo poll, no
  push; en el peor caso (usuario mira la PC 10s después del cambio en el
  celular, y la PC no tiene foco/visibility change ni abre Videos en ese
  momento) el delay sigue existiendo, solo que acotado a minutos en vez de
  indefinido.

### B. "Entrega 1" del plan de instant-matches (bus de eventos local)
Servicio de eventos del frontend (`publication-updated`, `match-updated`,
`stats-invalidated`) que invalida y recarga vistas sin esperar el cooldown,
descrito en `instant-matches-stats-plan-2026-08-31.md` Fase 7 Paso 3.

- Contra crítico: **no cubre el caso de este reporte**. Es invalidación
  dentro del mismo dispositivo (publicás en Electron → Electron se
  actualiza al toque); el escenario reportado es celular→PC, dispositivos
  distintos. Implementarlo solo no resuelve el bug tal como está reportado,
  aunque sí sirve para la queja de fondo de Estadísticas/Matches que
  motivó el plan original.

### C. Paso 4 del plan (canal SSE central→Electron)
Canal de eventos autenticado (Server-Sent Events) entre backend central y
Electron: `publication.created`, `publication.linked`,
`cross_match.completed`, con `userId` + revisión monotónica, reconexión
automática y polling de respaldo cada 30-60s. Detalle completo en
`instant-matches-stats-plan-2026-08-31.md` sección 4.

- Pro: es la única opción que resuelve de verdad la propagación
  cross-device sin esperar ningún tick ni pagar el costo de un pull
  completo repetido.
- Contra: cambio de arquitectura no trivial — conexión persistente
  autenticada por usuario en la central (que hoy no tiene ningún mecanismo
  de push), manejo de reconexión, y qué pasa si el proceso de
  Electron está en background/minimizado. Para un bug de severidad media,
  es la opción de mayor esfuerzo por lejos.

### D. Intermedia no explorada todavía: pull incremental
En vez de correr el `pullFromCloud` completo (todo el catálogo) más
seguido, agregar un endpoint liviano tipo
`/api/backup/changes-since?ts=<...>` en la central que devuelva solo lo que
cambió desde el último pull exitoso de esa instalación (por
`local_updated_at` o una revisión monotónica). Ese sí se podría llamar sin
cooldown (o con uno muy chico) sin pagar el costo O(N) de la opción A.

- Pro: resuelve el problema de fondo de la opción A (costo del pull
  completo) sin llegar a la complejidad de SSE.
- Contra: todavía es poll, no push — mismo límite de "si nadie mira la
  pantalla en ese momento, no se entera" que la opción A, solo que más
  barato de correr seguido. Requiere trabajo en central (nuevo endpoint +
  índice/timestamp confiable) y en local-backend (guardar el cursor del
  último pull exitoso).

## 5. Preguntas abiertas para quien lo analice

1. ¿Cuánto pesa en la práctica un `pullFromCloud` completo hoy? (medir
   contra el catálogo real de producción, no contra un caso sintético
   chico — ver nota de "mono-tenant, ~1121 files" en memoria de sesiones
   previas, puede haber crecido).
2. ¿El rate-limit de `/api` en la central tolera pulls cada 30s-1min desde
   una sola instalación sin devolver 429? (revisar configuración real en
   `backend/`, no asumir).
3. ¿Vale la pena resolver primero el descarte (síntoma 1, que depende de
   `pull`) y dejar la precarga a Nube (síntoma 2, `ensurePreload`) para una
   iteración separada, dado que son necesidades distintas (una es "que la
   PC vea un estado", la otra es "que la PC suba un archivo")?
4. Si se elige la opción D (pull incremental), ¿qué campo de la central es
   confiable como cursor? `local_updated_at` ya se usa para reconciliación
   de conflictos en `pullFromCloud` (ver línea ~301) — confirmar que no
   tiene casos donde retrocede o se pisa entre dispositivos antes de
   apoyarse en él para "qué es nuevo desde la última vez".
5. ¿El usuario prioriza tener esto resuelto pronto (→ opción A, aceptando
   el costo de reconciliaciones más frecuentes) o prefiere esperar a una
   solución más sólida (→ opción D o C)?

## 6. Recomendación tentativa (no decidida, para debatir)

Dado el hallazgo de la sección 3 (pull completo, no incremental), la opción
A "tal cual" parece más cara de lo que el reporte original asumía. Antes de
implementar cualquier cosa, valdría la pena:

1. Medir el costo real de un `pullFromCloud` contra el catálogo de
   producción (pregunta 1).
2. Si el costo es bajo, ir directo con la opción A (más rápida de
   implementar).
3. Si el costo es alto, evaluar la opción D como paso intermedio antes de
   llegar a SSE (opción C), que queda como la solución "correcta" a largo
   plazo pero de mayor esfuerzo.

No se tocó código para este bug — este documento es el entregable pedido
por el usuario para que se analice antes de decidir.

---
🤖 Documento generado con [Claude Code](https://claude.com/claude-code)

## 7. Revisión adicional del código (2026-09-06)

Se verificaron los disparadores y el pull en el checkout local. No se modificó
código ni se midió producción. Los siguientes hallazgos complementan el diagnóstico:

- **El límite configurado es 120 solicitudes por minuto por IP**, en
  `backend/src/middleware/rate-limit.middleware.ts`; se monta sobre `/api` en
  `backend/src/server.ts`. No equivale a 120 sincronizaciones: un pull consulta
  catálogo, configuración y vínculos de publicaciones; push y precarga agregan
  solicitudes. Consultar cada 30–60 segundos no implica por sí solo superar el
  límite, pero tampoco garantiza evitar 429 con el resto del tráfico de esa IP.
  Falta confirmar que producción ejecuta esta configuración.
- **Hay que refrescar la UI después de reconciliar SQLite.** El tick devuelve
  `void` y no emite una notificación de cambio. El hook de foco/visibilidad/timer
  no recarga Videos al finalizar; Videos solo encadena `loadPage` al tick de su
  montaje. Acortar el intervalo no garantiza que una vista ya abierta muestre
  el estado nuevo. El evento local de la opción B sí es útil como complemento
  del transporte entre dispositivos, aunque por sí solo no lo reemplaza.
- **Los fallos consumen cooldown.** `lastTick` se actualiza antes de ejecutar
  los jobs y sus errores se silencian. Una falla de red puede inhibir el próximo
  intento durante cinco minutos. Deben separarse último éxito, reintento con
  espera creciente y ejecución en curso.
- **No hay exclusión de ticks en curso.** El timestamp reduce disparos cercanos,
  pero `force=true` o una ejecución que dure más que el cooldown permiten
  solapamiento. La precarga tiene una protección propia por `contentId`; no
  reemplaza la exclusión para el conjunto push/pull.
- **El cursor incremental no puede copiar `local_updated_at` sin más.** La
  central recibe ese campo desde el cliente y, en la lectura legacy, mezcla
  registros de `backup_files` con `files`, usando también `updatedAt` central.
  Hace falta un cursor de cambios controlado por servidor y cobertura de las
  escrituras relevantes, incluidos vínculos y eliminaciones. El timestamp de
  resolución de conflictos y el cursor de entrega cumplen funciones distintas.

### Ajustes a la comparación de opciones

SSE notifica que ocurrió un cambio, pero **no elimina automáticamente el pull
completo**: requiere un payload aplicable o una lectura incremental/selectiva.
Además, el canal debe cubrir descartes y su reversión, no solo publicaciones y
matches. Un polling incremental periódico sí detecta cambios sin interacción
del usuario mientras el proceso esté activo; no necesita un evento de foco.
No se puede prometer ese plazo con la PC suspendida o la aplicación cerrada.

Recomendación técnica: diseñar primero una entrega incremental con cursor de
servidor, polling periódico de 30–60 segundos y recuperación al reconectar.
Tras aplicar cambios, invalidar las vistas y reevaluar la precarga cuando cambie
la cola. Mantener la reconciliación completa para inicio/recuperación y separar
su frecuencia del push. Si se exige latencia de pocos segundos, agregar SSE
sobre ese mecanismo. Esto preserva SQLite local y evita repetir el catálogo
completo para comprobar si hay novedades.

Antes de implementar, definir la latencia objetivo y medir tamaño/tiempo del
pull real. Validación propuesta: descarte y reversión desde móvil con Videos
abierto y sin cambio de foco; publicación que avance la precarga; desconexión y
reconexión; disparadores simultáneos; cambios locales pendientes; aislamiento
entre usuarios. Medir por separado llegada a SQLite, actualización visual e
inicio de precarga: terminar la transferencia depende del tamaño y la red.

## 8. Inventario de tráfico por ciclo (aportado por el usuario, verificado contra el código 2026-09-07)

Tabla de peticiones reales que genera un `runSyncTick` completo, con spot-check
línea por línea contra el checkout actual (no se corrió en producción — sigue
siendo análisis estático, no medición real).

**Llamadas del frontend al local-backend** (las tres de `runSyncTick`):

| Petición a la PC | Función |
|---|---|
| `POST /api/local/backup/push` | Envía respaldos a la central |
| `POST /api/local/backup/pull` | Descarga y reconcilia datos en SQLite |
| `POST /api/local/backup/ensure-preload` | Comprueba y prepara los próximos videos |

**Peticiones de la PC a la central que dispara cada una** — verificado contra
[`backup-sync.controller.ts`](../local-backend/src/controllers/backup-sync.controller.ts),
[`calendar-sync.service.ts`](../local-backend/src/services/calendar-sync.service.ts) y
[`remote-library-preload.service.ts`](../local-backend/src/services/remote-library-preload.service.ts):

| Etapa | Petición | Cantidad por ciclo¹ | Datos / trabajo |
|---|---|---:|---|
| Enviar catálogo | `POST /api/backup/files/bulk` | 1 | Envía **todos los archivos activos**, aunque no hayan cambiado |
| Enviar transcripciones | `POST /api/backup/transcripts/bulk` | 0–1 | Envía todas las transcripciones disponibles |
| Enviar publicaciones | `POST /api/backup/platform-videos/bulk` | 0–1 | Envía todos los vínculos locales de publicaciones |
| Enviar configuración | `POST /api/backup/config` | 1 | Envía preferencias y configuración de plataformas |
| Recibir catálogo | `GET /api/backup/files?includeResolved=true` | 1 | Descarga **todo el catálogo** y lo reconcilia en SQLite |
| Recibir configuración | `GET /api/backup/config` | 1 | Recupera configuración que falte localmente |
| Recibir publicaciones | `GET /api/backup/platform-videos` | 1 | Descarga vínculos y los aplica localmente |
| Consultar calendario | `GET /api/sync/calendar-config` | **2** ✅ confirmado | `syncCalendarFromCentral` (línea 20) actualiza SQLite; `ensurePreloadForNextVideos` vuelve a pedir el mismo endpoint en la línea 119 para sacar los próximos — es el mismo GET repetido dentro de la misma ejecución |
| Buscar copia remota | `GET /api/remote-library/videos/lookup?contentId=…` | 0–3 | Una por plataforma con "próximo" definido |
| Verificar copia | `GET /api/remote-library/videos/{id}` | 0–3 | Comprueba que tenga archivo y resolución compatible |
| Guardar próximo video | `PATCH /api/sync/calendar-config/{platform}` | 0–3 ✅ confirmado incondicional | Línea 143-147: se manda siempre que haya `nextRemoteLibraryVideoId`, sin comparar contra el valor previo — **no** compara si ya estaba precargado |

¹ Ciclo exitoso, con carpeta configurada y hasta tres plataformas. Si faltan
datos o hay fallos, cambia la cantidad. Si además hace falta subir un archivo
nuevo se suman `POST /api/remote-library/videos/import` (≤80 MiB) o el flujo
TUS por bloques (>80 MiB), más la miniatura.

**Ejemplo representativo:** con transcripciones, publicaciones y tres
próximos videos ya precargados, un ciclo exitoso genera **18 peticiones a la
central**, sin subir videos nuevos.

| Frecuencia del ciclo completo | Ciclos/hora | Peticiones/hora en ese ejemplo |
|---|---:|---:|
| Cada 20 minutos, fallback actual | 3 | 54 |
| Cada 5 minutos, con disparadores suficientes | 12 | 216 |
| Cada 30 segundos, cambio hipotético (opción A sin más) | 120 | **2.160** |
| Comprobación incremental cada 30 segundos, sin novedades | 120 | **120 consultas pequeñas** |

**Verificado contra el código real (2026-09-07)**, además de lo de la sección 7:
- Rate limit de `/api`: `apiRateLimit` en
  [`backend/src/middleware/rate-limit.middleware.ts`](../backend/src/middleware/rate-limit.middleware.ts)
  es `windowMs: 60_000, max: 120` — 120 req/min por IP. 2.160/hora (36/min en
  promedio, pero en ráfaga de 18 al momento del tick) deja poco margen si hay
  más de una fuente de tráfico en la misma IP; 120 consultas pequeñas/hora es
  trivial en comparación.
- El `PATCH calendar-config/{platform}` y el segundo `GET calendar-config`
  son trabajo redundante real, no hipotético — quedan como los dos targets de
  optimización más baratos de resolver antes de tocar la frecuencia del ciclo.

**Esto no cambia la recomendación de la sección 7** (cursor incremental
diseñado en el servidor + deduplicar el segundo `GET calendar-config` +
`PATCH` solo si cambia), la refuerza con números concretos: la opción A
"tal cual" (bajar el cooldown del ciclo completo a 30s) multiplicaría el
tráfico ~40x sobre el fallback actual por prácticamente nada nuevo cada vez,
mientras que una consulta incremental a la misma frecuencia cuesta ~18x menos.

No hay evidencia de que esto esté saturando MongoDB hoy — es una proyección
de tráfico, no una medición contra producción. Sigue pendiente medir contra
el catálogo real antes de decidir tamaño de cursor/paginación.

## 9. Riesgo adicional: durabilidad del cursor al cerrar la app (2026-09-07)

Pregunta del usuario: ¿el cursor incremental no fallaría si se hacen cambios
y se cierra la app? Son dos problemas distintos, uno ya existente y otro
propio del diseño de cursor:

**A. El push ya tiene este problema hoy, sin relación con el cursor.**
Confirmado en
[`backup-sync.controller.ts:202` (`pushToCloud`)](../local-backend/src/controllers/backup-sync.controller.ts) —
el endpoint que dispara `beforeunload` (`useSyncOrchestrator.ts:37-45`)
**espera el push completo** a central antes de responder, no es
fire-and-forget. Si el proceso de Electron se cierra antes de que esa ida y
vuelta termine (central lenta, catálogo grande, red floja), el cambio local
queda huérfano en SQLite hasta el próximo tick exitoso. Ningún diseño de
cursor de lectura arregla esto — es el camino de escritura (push), separado
del de lectura (pull/cursor).

**B. El cursor de lectura sí puede perder datos si se diseña mal, y "cerrar
la app justo después de un cambio" es el escenario que lo expone:**
- Si el cursor se persiste **antes o independiente** de aplicar el lote
  correspondiente a SQLite (avance optimista), cerrar la app a mitad de
  camino pierde ese lote para siempre — el dispositivo ya cree estar al día
  y nunca vuelve a pedirlo.
- Diseño seguro: persistir el cursor **solo después** de confirmar el lote
  aplicado (idealmente en el mismo commit que la escritura a SQLite). Cerrar
  a mitad de camino en ese caso solo repite trabajo la próxima vez, no
  pierde nada.
- Riesgo adicional sin que nadie cierre nada: si el cursor es un timestamp
  de pared y dos escrituras concurrentes (celular + PC) caen muy cerca,
  una puede quedar "por debajo" de un cursor que ya avanzó por la otra y no
  volver a pedirse jamás. Misma familia de problema ya señalado en la
  sección 7 sobre `local_updated_at` — reforzado acá porque aplica también
  sin ningún cierre de app de por medio.

**Conclusión para el diseño de la opción D**: el cursor tiene que ser
server-side, monotónico, y avanzarse en el cliente estrictamente después
(no antes ni en paralelo) de confirmar la aplicación durable del lote — y
el push necesita su propia solución de durabilidad (cola persistente de
cambios pendientes en SQLite con reintento al reabrir, no solo el best-effort
de `beforeunload`) para que "cerrar la app justo después de cambiar algo" no
siga siendo un caso perdido. Ninguno de los dos está implementado.

## 10. Alternativa "cruda": reconciliación completa más seguido, sin cursor (2026-09-07)

Pregunta del usuario: ¿qué complejidad tendría dejarlo crudo — subir/bajar
todo de una vez, sin contadores ni cursor?

**Complejidad de implementación: baja**, notablemente menor que la opción D.
No requiere endpoint nuevo en central, ni esquema de cursor/revisión, ni
ningún diseño de "cuándo es seguro avanzar el puntero" (todo lo de la
sección 9). Es esencialmente destrabar el disparador: separar el cooldown
de `pull()` del de `push()`/`ensurePreload()` en `syncOrchestrator.ts`, y
dispararlo en más eventos (abrir Videos/Matches, botón manual, foco) sin
esperar los 5 min — reusando `pullFromCloud`/`pushFilesToCloud` tal como
están hoy. Es la "opción A" original de la sección 4, sin modificar.

**Ventaja de fondo sobre el cursor**: una reconciliación completa es
**idempotente y autocurativa**. Si se interrumpe a mitad de camino (se
cierra la app, se corta la red), no se pierde nada permanentemente — la
próxima ejecución vuelve a traer/mandar todo y el estado converge solo.
Ninguno de los escenarios de la sección 9 (cursor avanzado antes de tiempo,
watermark pisado entre dispositivos concurrentes) puede ocurrir acá, porque
no existe ningún puntero que pueda quedar desalineado respecto a los datos
reales. En términos de riesgo de pérdida silenciosa de datos, esta opción es
estrictamente más segura que el cursor, no un compromiso a cambio de
simplicidad.

**Costo, ya cuantificado en la sección 8**: tráfico contra la central
proporcional a cuántas veces se dispare y al tamaño del catálogo (O(N) por
ciclo, ~1121 archivos hoy). Importa CÓMO se dispara:
- Timer ciego cada 30s → ~2.160 peticiones/hora — mal uso de esta opción,
  vuelve a la comparación desfavorable de la sección 8.
- Disparado por eventos reales de uso (abrir una vista, botón manual, foco)
  en vez de un reloj fijo → el volumen queda atado al uso real de la
  persona, probablemente razonable, pero sin medir contra producción
  todavía (pregunta abierta #1, sección 5).

**Lo que esta opción NO arregla** (independiente de crudo vs. incremental):
- El doble `GET calendar-config` y el `PATCH` incondicional (sección 8) —
  optimizaciones baratas de hacer aparte, con cualquiera de las dos rutas.
- Que el tick no refresca la vista ya abierta al terminar (sección 7) — sin
  esto, el usuario sigue sin ver el cambio aunque la SQLite ya esté al día.
- La durabilidad del push al cerrar la app (sección 9-A) — sigue siendo
  best-effort, esta opción ni la mejora ni la empeora.

**Conclusión**: dado el tamaño actual del catálogo (mono-tenant, ~1121
archivos) y que la complejidad/riesgo del cursor (sección 9) es real y no
trivial de blindar, la opción cruda disparada por eventos de uso real (no
por un timer agresivo) es la candidata más simple y con menos riesgo de
regresión para resolver el síntoma reportado. El cursor incremental
seguiría siendo la opción correcta si el catálogo creciera mucho o si
apareciera evidencia real de carga en central — ninguna de las dos cosas
está confirmada hoy.

## 11. Métricas de Mongo Atlas aportadas por el usuario (2026-09-07)

Captura del panel de Atlas (Opcounters / Connections / Connection Rate,
ventana 05:00-06:00, los tres nodos del replica set): opcounters entre 0 y
0.6 ops/seg con picos chicos, conexiones entre 2 y 30, tasa de conexión casi
siempre en 0. Es un cluster prácticamente ocioso, con margen amplio de sobra
frente a cualquier límite real de capacidad (CPU/IOPS/conexiones del tier)
— consistente con lo ya sabido por memoria (mono-tenant, un solo usuario
real con datos).

**Esto responde la mitad de capacidad de Mongo de la pregunta 2 (sección
5)**: no hay evidencia de que el cluster esté cerca de saturarse, y con este
margen la opción cruda (sección 10) no debería representar ningún riesgo
para Mongo en sí.

**Esto NO responde la otra mitad de la pregunta 2**: el `apiRateLimit` de
Express (`windowMs: 60_000, max: 120` en
[`rate-limit.middleware.ts`](../backend/src/middleware/rate-limit.middleware.ts))
se aplica en la capa HTTP de la central, **antes** de llegar a Mongo — un
cluster ocioso no evita un `429` si el tráfico por IP se acerca a ese límite
compartido con el resto de lo que haga esa PC. Sigue sin confirmarse cuánto
margen queda ahí.

Limitación de esta lectura: es una ventana de una sola hora, probablemente
reflejando la actividad de esta misma sesión de investigación, no un
período representativo de uso normal — sirve como cota de "cuánto margen
hay disponible", no como medición de tráfico típico.

## 12. Reproducción: Biblioteca LAN correcta y Nube pendiente (2026-09-07)

Caso reproducido con `final - sufre.mp4`, descartado en YouTube desde iOS
sobre la fila de Biblioteca LAN:

- SQLite/Electron y la fila LAN de iOS mostraron YouTube descartado.
- La fila separada de Nube para el mismo video continuó pendiente.
- El pull posterior procesó 1159 registros en 35 ms y no aplicó cambios al
  archivo local, por lo que este síntoma no era un retraso de repintado.

Causa confirmada en `backend/src/controllers/backup.controller.ts`: el bloque
que replica las resoluciones nuevas del push de Electron hacia
`remote_library_videos` calculaba únicamente `newlyPublished`. Un descarte
hecho contra el backend LAN sí actualizaba SQLite y luego `FileModel`, pero
nunca alcanzaba el documento separado de Biblioteca remota. El endpoint
central `POST /api/sync/file-platforms` ya contemplaba descartes; el hueco era
específicamente el camino LAN → SQLite → push completo → Nube.

Fix preparado: el mismo bloque compara las publicaciones y descartes resueltos
contra Nube en cada push completo, resuelve el documento remoto primero por
`contentId` y luego por nombre, y escribe solo las divergencias sin degradar
una publicación `confirmed`. Así también repara estados desalineados antes del
despliegue. Pruebas
unitarias cubren descarte nuevo, transición badge→descarte, protección de
`confirmed` y descarte→badge. Falta desplegar la central y repetir el caso;
el código local por sí solo no modifica Mongo de producción.

## 12. Síntesis final acordada (2026-09-07) — segunda revisión, con correcciones

Una segunda revisión corrigió tres sobre-afirmaciones de la síntesis
anterior (agente) antes de acordar el plan. Quedan registradas para que no
se repitan:

- **"Cluster ocioso" no prueba margen de capacidad.** La sección 11 permite
  decir "no se observó saturación en la ventana medida" (1 hora, pocas
  operaciones/conexiones) — **no** permite concluir "cualquier aumento de
  tráfico es seguro". Falta CPU, disco y transferencia real, no solo
  opcounters/conexiones.
- **El cierre de Electron (sección 9-A) NO es evidencia de que el celular
  falle en mandar el cambio a central.** Son dos cosas distintas: 9-A es
  sobre la PC dejando de pushear sus propios cambios al cerrarse; el
  reporte original (sección 3) ya estableció como causa raíz confirmada que
  el cambio de iOS **sí** llega bien a la central de inmediato. No hay
  hallazgo nuevo que respalde tratar una falla de envío del celular como
  hipótesis igual de probable que el gap ya confirmado (PC sin refrescar).
  Se retira esa comparación de una síntesis previa de este documento.
- **Disparar solo por eventos (foco/montaje/apertura de vista) no cubre el
  caso real reportado**: si la PC ya está abierta y con foco cuando se
  publica desde el celular, ningún evento del lado PC dispara nada — hace
  falta un respaldo periódico moderado además de los eventos, no en su
  reemplazo.
- El rate-limit de Express, aunque secundario, también puede alcanzarse por
  disparadores repetidos, varias instalaciones a la vez, o subidas TUS por
  bloques — hace falta agrupar/deduplicar disparadores y evitar que dos
  ticks corran solapados (ver hallazgo de la sección 7: hoy no hay exclusión
  de ticks en curso), independientemente de si se usa timer o no.
- Los tres ajustes "baratos" de la sección 10 no son automáticamente de
  bajo riesgo por parejo: sacar la lectura duplicada de calendario es
  simple; volver condicional el `PATCH` exige comparar bien que los
  punteros sean iguales y válidos antes de omitirlo; refrescar Videos al
  terminar el tick debe conservar filtro, página y cualquier edición
  abierta por el usuario en ese momento, no pisarla.

### Plan acordado (próximos pasos, sin implementar todavía)

1. Reproducir un descarte real y confirmar en qué tramo se frena:
   central → SQLite local → pantalla — para saber si el síntoma es del pull,
   de la reconciliación, o solo de la falta de refresco visual (sección 7).
2. Mantener el pull completo (opción cruda, sección 10) pero separado del
   push, con exclusión mutua para que no corran dos ticks solapados.
3. Refrescar la vista abierta al terminar el tick (preservando filtro,
   página y ediciones en curso) y eliminar las solicitudes redundantes
   (segundo `GET calendar-config`, `PATCH` condicionado a que el puntero
   realmente cambió).
4. Disparar por foco/apertura de vista/reconexión **más un respaldo
   periódico moderado** (no solo eventos) para cubrir el caso de uso
   simultáneo celular↔PC con la PC ya abierta.
5. Instrumentar duración, bytes y errores de cada tick para ajustar la
   frecuencia con datos reales en vez de una estimación — insumo directo
   para decidir después si hace falta el cursor incremental o SSE.

**Cursor incremental y SSE quedan fuera de la implementación inmediata.**
SSE podría justificarse igual más adelante si el objetivo de producto pasa
a requerir latencia de segundos — eso depende de la experiencia buscada,
no solo de si el catálogo es chico o Mongo está ocioso hoy.
