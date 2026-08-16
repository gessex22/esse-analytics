# Diseño: "Biblioteca LAN" auto-detectada (mobile, iOS + Android) — 2026-08-16

> Documento de **diseño e investigación**, no de implementación. Ningún cambio
> de código de producción acompaña a este documento. Formato y profundidad
> calcados de `docs/tiktok-duplicate-publish-design-2026-08-16.md` y
> `docs/single-primary-install-plan-2026-08-14.md`.

## Resumen ejecutivo

Hoy, "PC local" en `essenalytics-ios` es un modo de servidor **todo-o-nada**
(`ServerSettingsView.swift`): elegirlo redirige `CentralAPI.baseURL` —la
única base URL global de la app— al `local-backend` de la PC, y fuerza logout
porque un JWT de un backend no vale en otro (`JWT_SECRET` es una constante
de proceso). `PCLocalPublishView.swift` (pestaña Subir) es la única pantalla
que sabe hablarle a la PC en ese modo; `LibraryView.swift` (Videos) no tiene
ningún caso especial — su chip "Catálogo PC" pega a la CENTRAL
(`/api/backup/files`, solo metadata, sin reproducir), no a la PC.

**El hallazgo de partida se confirma: es correcto y es la pieza que habilita
todo este diseño.** `local-backend`'s `JWT_SECRET` (`local-backend/src/config.ts:26`)
y el de la central (`backend/src/middleware/auth.middleware.ts:5`) comparten
el mismo default (`'esse_secret_key_2024'`), y `local-backend`'s `verifyToken`
(`local-backend/src/middleware/auth.middleware.ts:10-23`) **no exige nada más
que una firma válida** — ni `installId`, ni `deviceId`, ni que el usuario sea
el owner de esa instancia. Esto significa que el JWT que ya vive en el
Keychain del teléfono (`KeychainTokenStore.shared.token`, emitido por la
central en el login normal, **sin tocar `CentralAPI.baseURL`**) sirve tal
cual para autenticar un request directo al `local-backend` de la PC por LAN.
Es exactamente lo que ya usa `local-backend/src/controllers/sync.controller.ts`
para reenviar eventos a la central (comentario explícito ahí, confirmado en
`docs/bug-reports.md:547`), solo que en sentido inverso.

Esto habilita el diseño pedido: un **segundo cliente HTTP paralelo**, dirigido
a la IP de la PC, que reusa el mismo JWT sin togar `CentralAPI.baseURL` ni la
sesión activa — "Biblioteca LAN" puede ser aditiva de verdad.

Hallazgo colateral importante (sección 1.3): ese mismo `verifyToken` permisivo
significa que **`GET /api/videos` no filtra por dueño** — cualquier cuenta con
un JWT válido (no necesariamente el dueño de esa PC) que llegue a la LAN
correcta ve el catálogo completo. Ya es así hoy con el modo "PC local"
manual; el auto-descubrimiento de este diseño lo hace más fácil de alcanzar
sin querer, así que se incluye una recomendación de hardening server-side de
bajo costo (no bloqueante para este diseño, ver sección 1.4).

Android **no tiene ningún equivalente al concepto completo** — solo tiene el
mismo selector de servidor todo-o-nada + descubrimiento NSD que iOS, pero
CERO código en `feature/upload`/`feature/library` que sepa hablarle al
contrato de `local-backend` (no existe `LocalPCVideoDTO`, ni pantalla
equivalente a `PCLocalPublishView`). El plan para Android es construir el
concepto entero, no solo agregar un switch (sección 7).

---

## 1. Confirmación del hallazgo JWT_SECRET compartido

### 1.1 — Los dos defaults coinciden

`backend/src/middleware/auth.middleware.ts:5`:
```ts
const JWT_SECRET = process.env.JWT_SECRET || 'esse_secret_key_2024';
```

`local-backend/src/config.ts:19-26`:
```ts
export const JWT_SECRET = LAB_MODE
  ? (process.env.LAB_JWT_SECRET || 'esse_lab_secret_never_use_in_prod')
  : (process.env.JWT_SECRET || 'esse_secret_key_2024');
```

`local-backend/.env.example:5` fija `JWT_SECRET=esse_secret_key_2024` — el
mismo valor. Fuera de modo Laboratorio (que usa `LAB_JWT_SECRET`, un secreto
deliberadamente distinto — ver comentario en `local-backend/src/config.ts:19-23`),
central y local-backend comparten secreto siempre que ninguno de los dos
override `JWT_SECRET` en su `.env` real. Esto **ya está verificado en
producción real**, no es solo un match de `.env.example`: `docs/bug-reports.md:547`
documenta que otra sesión minó un JWT propio con este mismo secreto default y
pegó exitosamente contra `https://api.esse-analytics.com` en producción.

### 1.2 — `local-backend`'s `verifyToken` no exige nada más

`local-backend/src/middleware/auth.middleware.ts:10-23`:
```ts
export function verifyToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Token requerido.' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as any;
    req.user = { id: payload.id, username: payload.username, role: payload.role, tier: payload.tier };
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido o expirado.' });
  }
}
```

Nada acá compara `payload.id`/`username` contra el owner de la instalación
(`configRepo.getOwner()`, `local-backend/src/db/config.repo.ts:100-104`), ni
pide un `installId`/`deviceId` adicional. El único middleware que sí hace un
chequeo de "rol de esta instalación" es `requirePrimaryDevice`
(`local-backend/src/middleware/auth.middleware.ts:34-45`), pero está montado
**solo** en `scan.routes.ts` (`POST /api/videos/scan/config`, `POST
/api/videos/scan`, `POST /api/local/setup/auto-detect` —
`local-backend/src/routes/scan.routes.ts:11-13`), no en las rutas de lectura
del catálogo (`video.routes.ts`, `stream.routes.ts`).

Confirmado también que `GET /api/videos` (`local-backend/src/routes/video.routes.ts:12`)
usa `verifyToken` solo, y su controller (`local-backend/src/controllers/video.controller.ts:16-33`,
`fileRepo.findAll`) **no recibe ni usa `req.user.id` en ningún filtro** — es
consulta plana sobre SQLite, sin scoping por usuario (tiene sentido: esta
SQLite es de una sola PC, con un solo dueño posible a la vez — pero eso no lo
hace cumplir `verifyToken`, ver 1.4).

### 1.3 — Confirmado en la práctica por el propio código de subida de iOS

`essenalytics-ios/Esse-Analytics/Features/Upload/LocalBackendUploadAPI.swift:70-105`
ya reusa `APIClient.shared` (que manda el JWT de `KeychainTokenStore`) contra
`local-backend`, y el comentario en `local-backend/src/controllers/sync.controller.ts:314`
confirma explícitamente: *"verifyToken -- JWT_SECRET es compartido entre
local-backend y la central"*. No es una inferencia nueva de este documento:
ya es el mecanismo con el que **hoy** funciona el modo "PC local" completo
(solo que hoy requiere pisar `CentralAPI.baseURL` entero para que
`APIClient.shared` termine hablándole a la PC).

**Conclusión: el hallazgo se confirma sin reservas.** Un segundo cliente que
apunte a la IP de la PC, usando el JWT ya guardado en Keychain, autentica
correctamente sin re-login — es la base técnica que hace viable el switch
aditivo.

### 1.4 — Hallazgo colateral: sin ese scoping, cualquier cuenta ve el catálogo de cualquier PC alcanzable

Como `verifyToken` no compara `req.user.username` contra el owner local, y
`cors()` en `local-backend/src/server.ts:44` no restringe origen, cualquier
JWT válido (de **cualquier cuenta** registrada en la central, no solo el
dueño de esa PC) que llegue por LAN a `GET /api/videos` de una PC ajena ve su
catálogo completo — nombre de archivo, duración, estado de publicación por
plataforma. `GET /api/videos/stream/:id` y `/api/videos/:fileId/thumbnail`
(`local-backend/src/routes/video.routes.ts:22`, `stream.routes.ts:8`) ni
siquiera piden token: cualquiera en la LAN que adivine/enumere un `fileId`
puede reproducir o descargar el video, sesión o no.

Esto **ya es así hoy** con el modo manual "PC local" (no es un problema nuevo
introducido por este diseño) — pero hoy requiere que alguien tipee a mano la
IP de una PC ajena para explotarlo, lo cual ya es una fricción/señal de
intención. El auto-descubrimiento de "Biblioteca LAN" **reduce esa fricción a
cero**: cualquier PC con EsseAnalytics prendida en la misma red WiFi (ej. una
red de oficina/coworking compartida) se ofrece sola, sin que el usuario haya
escrito nada.

**Recomendación (fuera del alcance estricto de este feature, pero anotada
para no perderla)**: agregar un chequeo barato en `verifyToken` o en un nuevo
middleware `requireOwnerOrNoOwnerSet` para las rutas de lectura del catálogo
(`GET /api/videos`, `/api/metrics`, `/api/calendar`, thumbnail/stream) — si
`configRepo.getOwner()` existe, exigir `req.user.username === owner.username`
(mismo criterio que ya usa `isOwner` en la central). Esto no bloquea el
diseño de "Biblioteca LAN" (que de todas formas solo debería mostrar/conectar
a la PC del propio usuario), pero cierra la superficie de exposición que el
auto-descubrimiento agranda. Se detalla como ítem de la Fase 0 en la sección
8.

---

## 2. Diseño del cliente dual (iOS)

### 2.1 — Por qué hoy es imposible ser aditivo sin tocarlo

`CentralAPI.baseURL` (`essenalytics-ios/Esse-Analytics/Core/Network/CentralAPI.swift:22-27`)
es una property computada global, respaldada por un solo valor en
`UserDefaults` (`customServerBaseURL`). `APIClient.send` construye la URL de
CADA request a partir de ese único global:

`essenalytics-ios/Esse-Analytics/Core/Network/APIClient.swift:95-114`:
```swift
private func send<Response: Decodable>(
    _ path: String, method: String, bodyData: Data?,
    queryItems: [URLQueryItem] = [], authenticated: Bool
) async throws -> Response {
    var url = CentralAPI.baseURL.appendingPathComponent(path)
    ...
    if authenticated, let token = await tokenStore.token {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    ...
}
```

Y `LocalBackendUploadAPI` (usado hoy solo desde `PCLocalPublishView`/
`PCLocalVideoPlayerView`) hereda ese acoplamiento: `streamURL`/`thumbnailURL`
(`LocalBackendUploadAPI.swift:82-88`) construyen la URL con
`CentralAPI.baseURL.appendingPathComponent(...)`, y `listPending`/`uploadX`
(`LocalBackendUploadAPI.swift:95-140`) reciben `apiClient: APIClient = .shared`
— que a su vez usa `CentralAPI.baseURL` internamente. **No hay ningún punto
de estas funciones que acepte hoy una base URL explícita** — todas asumen
que alguien ya puso a la app entera en modo "PC local" antes de llamarlas.

### 2.2 — Cambio mínimo: generalizar `APIClient` con un override de base URL, no un tipo nuevo

Se evaluaron dos caminos:

**A. Tipo nuevo (`LANLibraryClient`) que duplica `send`/decoder/encoder.**
Descartado: `APIClient.init` ya construye un `JSONDecoder`/`JSONEncoder` con
manejo de fechas no trivial (comentarios en `APIClient.swift:30-54` sobre
`withFractionalSeconds` y `dateEncodingStrategy = .iso8601`, cruciales para
que `publishedAt` no se corrompa — exactamente el bug de
`bug06_publishedat_now_on_retry`). Un tipo nuevo duplicaría esa lógica y
arriesgaría re-introducir ese bug si algún día `LocalPCVideoDTO` gana un
campo `Date`.

**B. Generalizar `APIClient` para aceptar una base URL explícita por
instancia (recomendado).** Cambios concretos:

1. `APIClient.swift:12-55` — agregar una property `private let baseURLOverride: URL?`
   y un parámetro opcional al init (`baseURLOverride: URL? = nil`). `.shared`
   sigue exactamente igual (override `nil`).
2. `APIClient.swift:102` — en `send`, resolver
   `let base = baseURLOverride ?? CentralAPI.baseURL` en vez de leer
   `CentralAPI.baseURL` directo. Un solo line change; el resto de `send`
   (token de `tokenStore`, manejo de 401, decode) queda intacto — **incluido
   el manejo de 401**, que hoy hace `authEventBus.emitSessionExpired()` +
   `tokenStore.clear()` (`APIClient.swift:128-143`). Ver 2.3 para por qué eso
   necesita un ajuste.
3. Un nuevo `static func lan(baseURL: URL) -> APIClient` (factory, no
   singleton — la IP de la PC cambia por sesión de descubrimiento) que
   construye `APIClient(baseURLOverride: baseURL)`. Se instancia una vez por
   `LibraryView`/`LANLibraryStore` (ver sección 4), no por request.
4. `LocalBackendUploadAPI.swift` — cambiar las firmas para recibir la base
   URL explícita en vez de asumir `CentralAPI.baseURL`:
   - `streamURL(id:)`/`thumbnailURL(id:)` (líneas 82-88) pasan a
     `streamURL(id:baseURL:)`/`thumbnailURL(id:baseURL:)`.
   - `listPending`/`uploadYoutube`/`uploadInstagram`/`uploadTikTok`
     (líneas 95-140) ya reciben `apiClient: APIClient = .shared` como
     parámetro — **no hace falta tocar su firma**, el caller nuevo
     (Biblioteca LAN) simplemente pasa `apiClient: .lan(baseURL: pcURL)` en
     vez de dejar el default. `PCLocalPublishView` (modo todo-o-nada) sigue
     llamando sin ese argumento, cero cambio de comportamiento ahí.

Este diseño es deliberadamente el de menor diff: **cero cambios de
comportamiento** para el modo "PC local" existente (sigue usando `.shared`
implícito), y la ruta nueva (Biblioteca LAN) es 100% aditiva vía un parámetro
opcional que hoy no existe.

### 2.3 — El manejo de 401 necesita diferenciarse por instancia

Riesgo real: si la PC de "Biblioteca LAN" devuelve 401 (JWT vencido, o el
`JWT_SECRET` real de esa PC no coincide con el default por algún motivo — ej.
el usuario lo cambió a mano en su `.env`), el código actual de
`APIClient.send` (líneas 128-143) dispara `tokenStore.clear()` +
`authEventBus.emitSessionExpired()` — **eso cerraría la sesión principal de
la app entera** por un fallo de un cliente secundario que se supone no debía
tocarla. Hace falta que ese bloque distinga `self === .shared` (o, más
simple, un flag `invalidatesSessionOn401: Bool` en el init, `true` solo para
`.shared`) — para que un 401 de la LAN solo se refleje como error local de
esa carga (ver sección 5, estado "no alcanzable") sin `emitSessionExpired()`.
Esto es un ajuste necesario en el mismo archivo que 2.2 (2), no un componente
nuevo.

### 2.4 — Diagrama de dependencia (antes / después)

```
Antes:
  CentralAPI.baseURL (1 global) ──▶ APIClient.shared ──▶ TODO el tráfico de la app
                                                          (incluido PCLocalPublishView,
                                                           si CentralAPI.baseURL == PC)

Después (aditivo):
  CentralAPI.baseURL (1 global) ──▶ APIClient.shared ──▶ tráfico normal de la app
                                                          (Central, o PC local en modo
                                                           todo-o-nada, sin cambios)

  pcURL descubierta (LAN)       ──▶ APIClient.lan(pcURL) ──▶ SOLO Biblioteca LAN
                                     (mismo tokenStore.token, sin tocar
                                      CentralAPI.baseURL ni el resto de la app)
```

---

## 3. Dónde vive en la UI: reemplazar/mejorar "Catálogo PC" vs. chip nuevo

### 3.1 — El código real hoy

`LibraryView.swift:59` (gate) y `:97-106`/`:378-389` (carga):

```swift
// FIX 2026-08-16: esto quedó hardcodeado en `false` desde que se
// implementó el chip -- ... el tercer chip "Catálogo PC" nunca llegó a
// aparecer para nadie.
private var canSeeBackupCatalog: Bool { currentUser?.isPremium == true }
```
```swift
if canSeeBackupCatalog, filter == .all || filter == .backupCatalog {
    let files = filter == .all
        ? backupFiles.filter { !localFileNames.contains($0.fileName) && !remoteFileNames.contains($0.fileName) }
        : backupFiles
    merged.append(contentsOf: files.map(LibraryListItem.backupCatalog))
}
```
```swift
private func loadRemoteSourcesIfNeeded() async {
    ...
    if canSeeBackupCatalog {
        let fetched = (try? await BackupCatalogAPI.list()) ?? backupFiles
        backupFiles = Array(fetched.sorted { $0.createdAt > $1.createdAt }.prefix(10))
    }
}
```

Y la fila es explícitamente de solo lectura (`LibraryView.swift:281-288`):
```swift
case .backupCatalog(let file):
    // Solo lectura -- sin bytes accesibles, nada que reproducir/borrar
    // desde acá (mirror del backup de escritorio).
    Button { backupOnlyNotice = true } label: { BackupCatalogRow(file: file) }
```

`visibleFilters` (`LibraryView.swift:319-324`) arma la lista de chips
visibles de forma estática por gate, sin ningún estado "reachable ahora
mismo":
```swift
private var visibleFilters: [LibraryFilter] {
    var options: [LibraryFilter] = [.all, .local]
    if canUseCloudStorage { options.append(.remote) }
    if canSeeBackupCatalog { options.append(.backupCatalog) }
    return options
}
```

### 3.2 — Opción A: fusionar en el mismo slot ("Catálogo PC" → "Biblioteca LAN")

Reusar `LibraryFilter.backupCatalog` (mismo caso enum, solo cambia label y
contenido) como la única entrada "cosas de tu PC", con dos sub-estados según
si la PC está alcanzable por LAN ahora mismo:
- **PC en la red**: filas reales (`LocalPCVideoDTO`), con thumbnail y
  reproducible (`PCLocalVideoPlayerView`).
- **PC no en la red**: cae al mirror de solo-metadata actual
  (`BackupCatalogAPI.list()`), tal cual está hoy.

Pros:
- Un solo lugar mental "lo que hay en mi PC" — no hay que explicarle al
  usuario por qué hay dos chips de "PC".
- El código de merge/dedup contra `localFileNames`/`remoteFileNames`
  (líneas 97-106) se reusa sin duplicar esa lógica para una cuarta fuente.
- Coincide con lo que ya sugiere el comentario existente del código (la
  intención original de "Catálogo PC" ya apuntaba a mostrar lo de la PC,
  solo que sin bytes por no tener acceso directo — Biblioteca LAN completa
  esa intención en vez de competir con ella).

Contras:
- **Gating incompatible tal cual está hoy**: `canSeeBackupCatalog` es
  `isPremium == true` (recién arreglado en este mismo repo el 2026-08-16).
  Pero el modo "PC local" (`PCLocalPublishView`) confirmado en
  `Features/Upload` **no tiene ningún gate de premium** (grep sin resultados
  en `PCLocalPublishView.swift`/`ServerSettingsView.swift`) — es gratis hoy.
  Fusionar sin decidir el gate primero dejaría a un usuario free sin poder
  ver la Biblioteca LAN aunque su PC esté prendida al lado — una regresión
  de UX rara (algo gratis en Subir, pago en Videos, para la misma PC).
- El mismo `LibraryListItem.backupCatalog(BackupFileDTO)` tendría que dejar
  de ser un tipo único — hace falta una variante interna (enum asociado o un
  campo `source: .lan | .centralMirror` en la fila) para que la UI sepa si
  debe abrir `backupOnlyNotice` (solo lectura) o `PCLocalVideoPlayerView`
  (reproducible) al tocar la fila — no es solo texto, cambia el
  comportamiento del tap.

### 3.3 — Opción B: chip nuevo, separado ("Biblioteca LAN" / "PC (LAN)")

Pros:
- Gate propio, desacoplado de `isPremium` desde el día uno — sin forzar una
  decisión sobre el gate de "Catálogo PC" existente.
- Affordance clara: un chip siempre significa "datos reales, reproducibles,
  de una PC prendida ahora"; el otro (Catálogo PC) siempre significa "mirror
  de metadata de la central, solo lectura" — sin sub-estados ocultos dentro
  del mismo chip.
- Encaja literalmente con lo que ya insinúa el comentario de
  `triggerAllModeLoadMoreIfNeeded`/`items` sobre "Local y Catálogo PC ya
  están cargados por completo" — Biblioteca LAN tendría su propia carga (con
  reachability en vivo), sin tener que enredar esa suposición.

Contras:
- Un quinto elemento en `visibleFilters` (hoy tope 4: Todos/Local/Nube/
  Catálogo PC) — manejable en el `ScrollView(.horizontal)` ya usado
  (`LibraryView.swift:293-314`), pero more UI real state.
- Dos chips con la palabra "PC" en pantalla al mismo tiempo (para un owner
  premium con PC alcanzable) es potencialmente confuso si no se nombran con
  cuidado — mitigable con copy claro ("Biblioteca LAN" vs "Catálogo PC
  (nube)"), pero es carga de diseño visual extra.
- Al no fusionar el merge/dedup, `items` (líneas 65-108) necesita una cuarta
  rama casi idéntica a la de `backupCatalog` — algo de duplicación de lógica
  de filtrado por nombre.

### 3.4 — Recomendación: Opción A, con el gate desacoplado de premium

Se recomienda **fusionar en el slot existente**, resolviendo el contra
principal (el gate) explícitamente en vez de dejarlo implícito:

- `canSeeBackupCatalog` se **separa en dos gates independientes**:
  - `canSeeLANLibrary: Bool` — **sin** chequeo de `isPremium`, gateado solo
    por "¿hay una PC descubierta en la LAN ahora?" (viene de la sección 4,
    no de la cuenta). Mismo criterio que ya usa `PCLocalPublishView` (modo
    todo-o-nada): la LAN es gratis porque no cuesta nada a la central (los
    bytes nunca salen de la LAN del usuario).
  - `canSeeBackupCatalogMirror: Bool` — el `isPremium == true` actual,
    **sin cambios**, solo como fallback cuando la LAN no está disponible.
  - `visibleFilters` muestra el chip "Biblioteca LAN" si
    `canSeeLANLibrary || canSeeBackupCatalogMirror` es true (label fijo
    "Biblioteca LAN" cuando hay señal de LAN activa esa sesión; degrada
    visualmente a mostrar "(solo referencia)" en el subtítulo cuando cae al
    mirror de metadata para un premium sin PC visible).
  - Un free sin PC en la LAN simplemente no ve el chip — igual que hoy.
- El tap-behavior por fila se resuelve con un `LibraryListItem` que ya
  distingue el sub-caso (`.lanVideo(LocalPCVideoDTO, pcBaseURL: URL)` vs
  `.backupCatalogMirror(BackupFileDTO)`), en vez de forzar un solo tipo con
  ambigüedad de comportamiento.

Esto le da al usuario exactamente lo que pidió: "una fuente más" en el mismo
lugar donde ya esperaba ver algo de su PC, sin duplicar el concepto de chip,
y sin la regresión de gate que la fusión ingenua introduciría.

---

## 4. Descubrimiento automático + reconciliación

### 4.1 — Estado actual: descubrimiento atado al ciclo de vida de una pantalla de Ajustes

`LocalPCDiscovery` (`ServerSettingsView.swift:349-372`) es una clase NO
singleton, instanciada como `@StateObject` **dentro de `ServerSettingsView`**
(línea 33), arrancada en `.onAppear`/parada en `.onDisappear` (líneas 57-58).
Fuera de esa pantalla, no hay descubrimiento corriendo — `LibraryView` no
tiene ninguna referencia a Bonjour hoy.

### 4.2 — Diseño: servicio singleton, mismo patrón que `LabModeStatus`

`LabModeStatus` (`Core/Network/LabModeStatus.swift:11-49`) ya es el patrón a
copiar: `@MainActor final class ... ObservableObject`, `static let shared`,
sin timer propio — se refresca en checkpoints naturales de navegación
(comentario en líneas 21-26: "se llama desde RootView al loguearse/reabrir,
SettingsView tras guardar, AppTopBarModifier al mostrar cualquier tab").

Propuesta: `LANPCDiscoveryStore` (nuevo, `Core/Network/` o
`Features/Library/`), singleton `@MainActor`:

```swift
@MainActor
final class LANPCDiscoveryStore: NSObject, ObservableObject, NetServiceBrowserDelegate, NetServiceDelegate {
    static let shared = LANPCDiscoveryStore()
    @Published private(set) var found: (name: String, url: URL)?
    // ... misma implementación NetServiceBrowser que LocalPCDiscovery,
    // pero singleton y con contador de referencias (ver 4.3)
}
```

`ServerSettingsView` puede seguir usando su propio `LocalPCDiscovery`
`@StateObject` privado (no hace falta tocarlo — es un componente ya probado
para ese caso puntual), o migrar a este singleton compartido. Recomendado
migrarlo para no tener dos implementaciones NSNetService divergentes en el
repo — costo bajo (misma API pública, `start()`/`stop()`), pero no
estrictamente necesario para este feature; se deja como ítem de la Fase 1
(ver sección 8), no bloqueante.

### 4.3 — Cuándo correr la búsqueda: conteo de referencias, no un solo "dueño"

Bonjour/NSNetServiceBrowser tiene costo real de radio (multicast sobre
WiFi) — no debe quedar corriendo permanentemente en background. Regla
propuesta:
- `start()`/`stop()` pasan a incrementar/decrementar un contador interno
  (`activeObservers: Int`), no un simple on/off — así `ServerSettingsView` Y
  `LibraryView` pueden pedir descubrimiento simultáneamente sin pisarse (si
  `LibraryView` para el suyo al salir de pantalla mientras `ServerSettingsView`
  sigue abierta en otro punto de navegación, Bonjour sigue corriendo para
  esta última).
- `LibraryView.body` llama `LANPCDiscoveryStore.shared.start()` en `.task`
  (o `.onAppear`) y `.stop()` en `.onDisappear` — mismo ciclo de vida que ya
  usa `ServerSettingsView` hoy (líneas 57-58), solo que apuntando al
  singleton compartido. Esto significa: la búsqueda corre **mientras el
  usuario está mirando la pestaña Videos**, no en background continuo ni al
  arrancar la app — barato y suficiente (la LAN local resuelve en 1-3s
  típico con Bonjour, ver timeout de 5s ya usado en
  `service.resolve(withTimeout: 5)`, línea 365).
- **No** correr en el arranque de la app (`RootView`) ni polling periódico
  con timer — el costo/beneficio no lo justifica para una pestaña que no es
  la de arranque por default, y evita drenar batería para usuarios que nunca
  usan la PC por LAN.

### 4.4 — Reconciliación mientras la lista está abierta

El caso "la PC aparece o desaparece mientras el usuario está mirando Videos"
no es solo el primer fetch — hace falta:
1. `@Published found` en el store dispara re-render de `LibraryView`
   automáticamente (SwiftUI observa `ObservableObject`) — sin código extra,
   la fila "Biblioteca LAN" cambia de estado (metadata mirror → reproducible)
   en cuanto Bonjour resuelve, sin que el usuario tenga que pull-to-refresh.
2. **Pero** que Bonjour encuentre el servicio no garantiza que siga
   respondiendo — la PC pudo apagarse justo después del anuncio, o el
   usuario cambió de red. Por eso, antes de mostrar filas reales, hace falta
   un chequeo vivo tipo `ServerHealthCheck.check(url:)` (ya existe,
   `ServerSettingsView.swift:328-345`, genérico y reusable tal cual — no
   hace falta un nuevo chequeo) contra `GET api/health` de la PC descubierta,
   con timeout corto (5s, mismo valor ya usado). Solo si ese check pasa se
   promueve `found` a "PC lista" (nuevo `@Published var reachable: Bool`, o
   un enum de 3 estados `.searching | .found(unverified) | .reachable(URL)`).
3. Si un request real a `listPending`/`streamURL` falla en medio de la
   sesión (la PC se apagó a mitad de scroll), degradar la fila a error
   puntual sin re-disparar todo el discovery — mismo criterio que
   `PCLocalPublishView`'s `loadError` + botón "Reintentar" (líneas 35-44),
   aplicado a este contexto.
4. Al volver a encontrar la PC tras una pérdida (`onServiceLost` en NSD/
   Bonjour, no manejado hoy en `LocalPCDiscovery` — línea 362-366 no tiene
   handler `didRemove`), limpiar `found`/`reachable` para que la UI vuelva a
   degradar al mirror de metadata en vez de quedar mostrando una fila
   "reproducible" apuntando a una PC que ya no está. Este es un gap real en
   el componente actual (`LocalPCDiscovery` no implementa
   `netServiceBrowser(_:didRemove:moreComing:)`) que el nuevo store sí debe
   cubrir.

### 4.5 — Hueco encontrado en revisión: ¿y si hay más de una PC en la red?

**No cubierto en el diseño original de este documento** — `found` estaba
modelado como un único opcional (`(name: String, url: URL)?`), calcado de
`LocalPCDiscovery` (que tampoco lo maneja: `ServerSettingsView.swift:114-135`
solo muestra "la" PC encontrada, sin lista). Eso alcanza para el caso de
Ajustes (el usuario tipea/confirma una sola IP a mano), pero **no alcanza
para auto-descubrimiento sin fricción**, donde puede haber legítimamente más
de una máquina con EsseAnalytics corriendo en la misma red — el caso más
concreto y ya real hoy mismo: la Opción C de Electron (sección 8) hace que
una PC secundaria hable con la primaria por LAN, así que en una red con esa
feature en uso puede haber 2+ instalaciones anunciando `_esseanalytics._tcp.`
simultáneamente, sin ninguna relación con "cuál es la mía".

Corrección al diseño:

1. `LANPCDiscoveryStore.found` pasa a `@Published private(set) var
   discovered: [DiscoveredPC] = []` (array, no opcional). Cada entrada
   guarda `name`/`url` tal como hoy, más un estado de verificación
   (`.unverified | .verifying | .authorized | .rejected`).
2. Cada candidato resuelto por Bonjour pasa por el health check (4.4, punto
   2) y, si responde, un intento real de `GET /api/videos` con el JWT actual
   — **no un endpoint nuevo**: una vez aplicado el hardening de Fase 0 (que
   agrega el chequeo de owner, sección 1.4), un candidato que no sea "tu" PC
   responde 403 ahí mismo, y el cliente lo descarta sin mostrarlo nunca en
   la UI. Antes de que la Fase 0 esté aplicada, este mismo intento sigue
   sirviendo como heurística de cortesía (cualquier PC alcanzable respondería
   200 hoy) — dejarlo anotado explícitamente como protección débil hasta que
   la Fase 0 landee, no como el mecanismo de seguridad real (ese vive del
   lado servidor, no acá).
3. **Resultado con 1 sola PC autorizada** (el caso normal, sin cambio de UX):
   auto-selecciona esa, igual que el diseño original.
4. **Resultado con 2+ PCs autorizadas** (caso raro pero real, ej. el mismo
   usuario con primaria+secundaria de la Opción C ambas alcanzables, o dos
   cuentas propias en la misma oficina): mostrar un picker liviano — mismo
   patrón visual que la fila "PC encontrada: {nombre}" que ya existe en
   `ServerSettingsView.swift:114-130`, solo que listando todas en vez de una.
   No autoseleccionar ninguna por default en este caso: mejor pedirle al
   usuario que elija una vez que quedarse pegado a la que resolvió primero
   por orden de llegada de la red (no determinístico, mala UX si cambia de
   sesión a sesión).

---

## 5. Reproducción/thumbnail

Se confirma: **reusar tal cual**, sin variante nueva. `PCLocalVideoPlayerView.swift`
y `LocalBackendUploadAPI.streamURL`/`thumbnailURL` (`LocalBackendUploadAPI.swift:70-88`)
ya están construidos, probados en producción (2026-08-16, BUG-2026-08-16-03,
según el propio comentario del archivo) y **sin auth por token** — el
comentario explícito confirma que es intencional: *"local-backend confía en
que estar en la misma LAN ya es suficiente"* (líneas 76-78). Esto significa
que, a diferencia del cliente `APIClient` (que sí manda `Authorization:
Bearer`), `streamURL`/`thumbnailURL` no necesitan pasar por el cliente dual
de la sección 2 en absoluto — son URLs "peladas" que cualquier
`AVURLAsset`/`AsyncImage` puede cargar directo, solo necesitan la base URL de
la PC (que sí sale del discovery de la sección 4).

Único cambio necesario: los dos métodos pasan a recibir `baseURL: URL`
explícito en vez de leer `CentralAPI.baseURL` (ver 2.2, punto 4) — cambio
mecánico, cero riesgo nuevo de seguridad (siguen sin token, tal como ya están
hoy en el modo todo-o-nada).

---

## 6. ¿Publicar desde esta vista, o solo preview?

**Recomendación: solo lectura/preview, no publicar desde Biblioteca LAN —
mandar a Subir (que cambia a `PCLocalPublishView` completo) para publicar.**

Justificación con el código existente:

1. `PCLocalPublishView`/`PCLocalPlatformFormsView` (`PCLocalPublishView.swift:103-344`)
   ya es una pantalla completa y bien resuelta para publicar contra la PC —
   picker de cola, 3 formularios independientes por plataforma, opciones de
   TikTok cargadas async, reproductor embebido. Duplicar ese flujo dentro de
   `LibraryView` (que ya es un archivo de 639 líneas con lógica de merge de
   3 fuentes) sería trabajo redundante sin beneficio de UX — el usuario que
   quiere publicar ya tiene un lugar dedicado y probado.
2. `LibraryView` en general **no publica** para ninguna de sus otras 3
   fuentes hoy — `local` se edita/borra pero no "publica" desde ahí
   (publicar on-device pasa por `UploadView`), `remote` es la cola de Nube
   (mismo patrón: se administra en Subir), y `backupCatalog` es
   explícitamente de solo lectura (`backupOnlyNotice`, línea 285). Agregar
   publicación real solo para el caso LAN rompería la consistencia de rol
   que la vista ya tiene ("Videos" = catálogo/organización, "Subir" =
   acción de publicar) en las 4 fuentes.
3. El estado de publicación en memoria de `PCLocalPlatformFormsView` (sin
   persistencia si la app se cierra a mitad de una subida, según su propio
   comentario en `PCLocalPublishView.swift:12-17`) ya es una limitación
   conocida y aceptada para el flujo dedicado — replicarla en una vista que
   además tiene que lidiar con reconciliación de discovery (sección 4) sería
   agregar superficie de bug sin necesidad.
4. Acción concreta propuesta: tocar una fila de Biblioteca LAN abre
   `PCLocalVideoPlayerView` (preview, ya construido) con un botón adicional
   "Publicar desde esta PC" que navega a la pestaña Subir **y** fuerza el
   modo `PCLocalPublishView` sin que el usuario tenga que ir a Ajustes →
   Servidor a mano — esto es un puente de UX razonable (evita el viaje
   manual) sin duplicar el formulario de publicación en dos lugares.

---

## 7. Paridad Android — estado real, investigado desde cero

### 7.1 — Lo que SÍ existe: el mismo selector todo-o-nada + NSD

`essenalytics-android/feature/settings/src/main/kotlin/.../LocalPcDiscovery.kt`
(archivo completo, 45 líneas) implementa descubrimiento vía `NsdManager`
(Network Service Discovery, el equivalente Android a Bonjour), buscando el
mismo tipo de servicio (`"_esseanalytics._tcp."`, línea 38) que anuncia
`electron/src/main.ts:60-66` — confirmado compatible sin cambios de
protocolo.

`SettingsScreen.kt:127-146` tiene los mismos 3 botones que iOS
(`ServerSettingsView.swift`): "Usar esta PC (descubierta)" / "Central" /
"PC local" / "Laboratorio", escribiendo a `SettingsStore.serverUrl`
(`core/datastore/.../SettingsStore.kt:41-47`). `NetworkModule.kt:106` arma el
`Retrofit.baseUrl` de **toda la app** a partir de ese mismo valor
(`runBlocking { settingsStore.serverUrl.first() }.ifBlank { CENTRAL_BASE_URL }`)
— mismo patrón todo-o-nada que `CentralAPI.baseURL` en iOS, un solo target
global para todos los `Retrofit` services inyectados.

### 7.2 — Lo que NO existe: ningún equivalente a `PCLocalPublishView`/`LocalBackendUploadAPI`

Búsqueda dirigida en `feature/upload` y `feature/library` (los dos lugares
donde tendría que estar si existiera):
- Sin resultados para `no_completo`, `LocalPCVideo`, `listPending`,
  `PC local`/`pcLocal`/`LocalPc` en `feature/upload/src/main/kotlin` — ni
  `UploadScreen.kt` ni `UploadViewModel.kt` tienen ninguna rama que reaccione
  al modo "PC local" del selector de servidor. Si un usuario Android
  cambiara `serverUrl` a la IP de su PC hoy, `UploadScreen` seguiría
  intentando los mismos endpoints de siempre (`AuthApi`, `BackupApi`,
  `RemoteLibraryApi`, `SyncApi` — ninguno de los cuales existe en
  `local-backend`, que solo implementa `auth-proxy`, `video`, `stream`,
  `youtube/instagram/tiktok-upload`, no el contrato de Biblioteca remota) —
  fallaría silenciosamente o con errores de red confusos, nunca mostraría el
  catálogo de la PC.
- `feature/library` sí tiene la contraparte del chip "Catálogo PC"
  (`BackupDtos.kt`, uso en `LibraryViewModel.kt`/`LibraryScreen.kt`/
  `LibraryListItem.kt` — mismo mirror de metadata central que iOS), pero
  **cero** referencia a `PC local`/`LocalPc` ahí tampoco.

**Confirmado: Android tiene la mitad "descubrir un servidor" del concepto
(gracias a que `LocalPcDiscovery.kt`+selector de servidor ya se construyeron
para el modo todo-o-nada), pero le falta enteramente la mitad "hablarle al
contrato de `local-backend` con un cliente propio" que iOS sí tiene en
`Features/Upload/LocalBackendUploadAPI.swift`+`PCLocalPublishView.swift`.**
No es un caso de "agregar un switch a algo que ya existe" como en iOS — es
construir, desde cero:

1. Un servicio Retrofit nuevo (`LocalBackendApi.kt`, en `core/network`,
   mirror de `LocalBackendUploadAPI.swift`) con los mismos 6 endpoints
   (`GET /api/videos` filtrado, `GET /api/videos/stream/:id`,
   `GET /api/videos/:fileId/thumbnail`, `POST /api/{youtube,instagram,tiktok}/upload`),
   apuntando a una `baseUrl` **distinta** del `Retrofit` inyectado por
   `NetworkModule.kt` (que sigue atado a `serverUrl`/modo todo-o-nada) — la
   misma generalización de "cliente con base URL explícita" que la sección 2
   diseña para iOS, pero en Retrofit/OkHttp: un segundo `Retrofit.Builder`
   con `.baseUrl(pcUrl)` construido on-demand (no vía Hilt singleton, la IP
   cambia por sesión de discovery), reusando el mismo `OkHttpClient` base
   (interceptors de logging, etc.) pero **sin** el `AuthInterceptor`/
   `AuthAuthenticator` que hoy asumen el flujo de refresh de la central
   (`core/network/.../AuthInterceptor.kt`, `AuthAuthenticator.kt`) — hace
   falta confirmar si esos interceptors asumen implícitamente `baseUrl ==
   CENTRAL_BASE_URL` en algún punto antes de reusarlos tal cual para este
   segundo cliente (pendiente de lectura línea por línea, no cubierto en
   esta pasada — anotado como riesgo a resolver en la Fase 4, sección 8).
2. Un DTO nuevo (`LocalPcVideoDto.kt`, mirror de `LocalPCVideoDTO`), y su
   `isPending` (mismo criterio "menos de 3 plataformas resueltas").
3. Una pantalla nueva (`LocalPcPublishScreen.kt` o extender `UploadScreen.kt`
   con una rama condicional, evaluar cuál encaja mejor con el patrón de
   Compose/Hilt ya usado en `feature/upload` — no analizado en profundidad
   en esta pasada, es trabajo de diseño de detalle de la Fase 4) equivalente
   a `PCLocalPublishView`.
4. Un reproductor equivalente a `PCLocalVideoPlayerView` — Android ya tiene
   `VideoPlayerDialog.kt` en `feature/library`; evaluar si sirve tal cual
   apuntando a la `streamUrl` de la PC (probable que sí, dado que ya maneja
   reproducción de `RemoteLibraryStreamUrl` con lógica de URL similar —
   `core/network/.../RemoteLibraryStreamUrl.kt`).
5. El chip "Biblioteca LAN" en `LibraryScreen.kt`/`LibraryViewModel.kt`,
   espejando la decisión de la sección 3.4 (mismo slot que el chip
   `backupCatalog` existente, gate propio desacoplado de premium).

### 7.3 — mDNS/NSD: ya cubierto, sin trabajo nuevo

Confirmado explícitamente (pedido del punto 6 del brief): Android **sí**
tiene su propio descubrimiento de red — `LocalPcDiscovery.kt` usa
`android.net.nsd.NsdManager`, el NSD nativo de Android (equivalente a
Bonjour/mDNS), ya apuntando al mismo `_esseanalytics._tcp.` que anuncia
Electron. No hace falta ningún trabajo de descubrimiento nuevo para Android
— el gap está 100% del lado "consumir el contrato de local-backend", no del
lado "encontrar la PC".

---

## 8. Alineación con el trabajo de Electron de hoy (Opción C)

`content-automation-dashboard` tiene, en la rama `feat/electron-lan-client-secondary`
(commit `f873865`, no mergeada a `main`), un diseño+implementación de una PC
secundaria como cliente LAN de la primaria — mismo espíritu (descubrir +
consumir el `local-backend` de otra PC por LAN), documentado en
`docs/single-primary-install-plan-2026-08-14.md`, sección "Opción C
(evaluada 2026-08-16)". Ese documento cita explícitamente a
`ServerSettingsView.swift`/`PCLocalPublishView.swift` como el patrón ya
probado que decidieron reusar — es decir, el trabajo de hoy en Electron ya
se inspiró en el mismo código que este documento diseña extender.

No hay que integrar ambos trabajos (uno es desktop-secundaria→desktop-
primaria, este es mobile→PC), pero vale la pena anotar convenciones de
nombres que, si se alinean, evitan que terminen pareciendo dos soluciones
distintas para el mismo problema:

| Concepto | Electron (Opción C, esta rama) | iOS hoy | Propuesta este doc |
|---|---|---|---|
| Nombre de la preferencia/feature en UI | — (pendiente, sección 3 del plan de Opción C dice "no existe hoy") | "PC local" (modo todo-o-nada) | **"Biblioteca LAN"** (aditivo) |
| Override de base URL | `IS_LAN_CLIENT`/`LAN_SERVER_URL`/`setServerOverride` (`frontend/src/config.ts`) | `CentralAPI.customServerURLString`/`ServerPresetStore` | Nuevo `baseURLOverride` en `APIClient` (sección 2) |
| Health check antes de conectar | `GET /api/local/health`, exige `data.local === true` (`ServerConnectionPanel.tsx`) | `GET api/health`, compara `environment` (`ServerHealthCheck`) | Reusa `ServerHealthCheck` tal cual (sección 4.4) — **estos dos NO son el mismo endpoint hoy** (`/api/local/health` vs `api/health`), vale la pena confirmar si es intencional o un mismatch a unificar en una pasada futura, no de este documento |
| Servicio Bonjour/mDNS | `electron/src/main.ts:60-66`, ya anuncia `_esseanalytics._tcp` | `LocalPCDiscovery`, consume el mismo tipo | `LANPCDiscoveryStore` (sección 4.2), mismo tipo |
| JWT compartido central↔local-backend | Mismo mecanismo (`JWT_SECRET`), confirmado en `auth.middleware.ts` de ambos backends | Confirmado en este doc, sección 1 | Sin cambios — mismo mecanismo |

**Resuelto 2026-08-16 (Fase 5)**: son dos endpoints REALMENTE distintos, no
un mismatch accidental. `GET /api/local/health` (`local-admin.routes.ts:327`)
es el auto-chequeo del frontend contra **su propio** backend —
`useBackendType.ts` lo usa para el banner de Laboratorio y
`pendingHistoryEvents` (BUG-2026-08-15-07), datos operativos internos que no
tiene sentido exponerle a un cliente ajeno probando por LAN. `GET /api/health`
(`server.ts:53`) es el genérico de identidad+entorno (`service`,
`environment`), sin datos internos — el contrato correcto para "¿sos vos,
EsseAnalytics?" desde afuera, que es justo lo que `ServerHealthCheck.swift`
ya usaba en iOS. `ServerConnectionPanel.tsx` (Opción C) pasó a usar
`/api/health` también (`data.service === 'esse-local-backend'` en vez de
`data.local === true`), alineado con iOS — commit `8c3b39d` en
`feat/electron-lan-client-secondary` (rama todavía sin mergear, ver estado
general de esa rama). `/api/local/health` queda reservado exclusivamente
para el auto-chequeo de cada frontend contra sí mismo, nunca para verificar
una PC ajena.

---

## 9. Plan de implementación por fases

### Fase 0 — Hardening server-side (local-backend), opcional pero recomendado antes de auto-descubrir

- Agregar `requireOwnerOrNoOwnerSet` (o extender `verifyToken`) en
  `local-backend/src/routes/video.routes.ts` (`GET /api/videos`,
  `/api/metrics`, `/api/calendar`) comparando `req.user.username` contra
  `configRepo.getOwner()?.username` cuando existe owner.
- **Agregado en revisión — no estaba en el alcance original de esta fase**:
  `local-backend/src/routes/stream.routes.ts` (`GET /api/videos/stream/:id`,
  `GET /api/videos/download/:id`) y el thumbnail de `video.routes.ts`
  (`GET /api/videos/:fileId/thumbnail`) son en realidad **más urgentes** que
  las rutas de arriba — según la sección 1.4, esas dos ni siquiera piden
  token, no solo les falta el chequeo de owner. No se les puede aplicar el
  mismo `requireOwnerOrNoOwnerSet` tal cual (dependen de `verifyToken`
  corriendo antes, y hoy no lo tienen) — necesitan primero un `?token=` por
  query param (mismo patrón que ya usa `RemoteLibraryAPI.streamURL`/
  `thumbnailURL` en la central, sección 5, porque `<img src>`/`AVURLAsset`
  no pueden mandar header `Authorization`), y recién ahí el chequeo de owner
  encima. Esto es un cambio de contrato (rompe la firma de
  `LocalBackendUploadAPI.streamURL(id:)`/`thumbnailURL(id:)` de la sección 5,
  que hoy son URLs peladas sin query params) — dimensionarlo aparte del
  primer punto de esta fase, no asumir que es el mismo esfuerzo.
- Verificable con `npx tsc --noEmit` en `local-backend/` (mismo baseline que
  ya usa el repo para verificar sin build real) + prueba manual con `curl` y
  dos JWTs de cuentas distintas (mismo criterio que ya usó otra sesión para
  confirmar el hallazgo de la sección 1 — minar un JWT con el secreto
  default, sin pedir credenciales reales).
- No bloquea las fases siguientes (mobile puede implementarse en paralelo),
  pero reduce la superficie de exposición del auto-descubrimiento antes de
  que llegue a producción.

### Fase 1 — iOS: cliente dual + discovery singleton (sin UI nueva todavía)

- `APIClient.swift`: agregar `baseURLOverride`/`invalidatesSessionOn401`
  (sección 2.2-2.3) y el factory `.lan(baseURL:)`.
- `LocalBackendUploadAPI.swift`: `streamURL`/`thumbnailURL` reciben
  `baseURL: URL` explícito.
- Nuevo `LANPCDiscoveryStore` (sección 4.2), con conteo de referencias
  (4.3) y manejo de `didRemove` (4.4, punto 4) — gap que ni siquiera
  `LocalPCDiscovery` actual cubre hoy.
- Verificable sin build real: lectura de código + `swiftc -parse` si hace
  falta chequeo sintáctico rápido; verificación real requiere Xcode. Este
  repo confirmó que se puede compilar de verdad por SSH a la Mac
  (`macgessemberg22`, sin tokens, ver memoria de sesión `ios_ssh_build` si
  la sesión que implemente tiene acceso a ella) — usar ese camino para el
  build real antes de dar la fase por cerrada, no asumir que "parsea" a mano
  alcanza.

### Fase 2 — iOS: UI en `LibraryView` (chip fusionado, sección 3.4)

- Separar `canSeeBackupCatalog` en `canSeeLANLibrary`/
  `canSeeBackupCatalogMirror` (sección 3.4).
- `LibraryListItem` gana el sub-caso LAN vs mirror (mismo enum,
  `.backupCatalog` con payload extendido, o casos separados — decisión de
  detalle de implementación, no de este diseño).
- Fila LAN abre `PCLocalVideoPlayerView` con base URL de la PC descubierta;
  botón "Publicar desde esta PC" navega a Subir en modo `PCLocalPublishView`
  (sección 6).
- Verificación: build real por SSH (igual que Fase 1) + prueba manual con
  una PC real en la misma LAN que el simulador/dispositivo de prueba (no
  hay forma de simular Bonjour sin una PC real emitiendo el servicio).

### Fase 3 — iOS: reconciliación en vivo (sección 4.4, puntos 2-4)

- Health check antes de promover `found` → `reachable`.
- Degradar a mirror ante fallo puntual de un request (sin re-disparar
  discovery entero).
- Puede ir en la misma fase que la 2 si el volumen de cambio lo permite, se
  separa acá solo porque es la parte con más riesgo de bugs de estado
  (carreras entre discovery/health-check/requests reales) y conviene
  poderla revertir sola si algo sale mal en producción.

### Fase 4 — Android: construir el concepto entero (sección 7.2)

- `LocalBackendApi.kt` + segundo `Retrofit.Builder` on-demand (mirror de la
  Fase 1 de iOS, pero investigar primero si `AuthInterceptor`/
  `AuthAuthenticator` son reusables tal cual para un `baseUrl` que no es la
  central — riesgo anotado en 7.2, punto 1, sin resolver en esta pasada).
- `LocalPcVideoDto.kt`.
- Pantalla equivalente a `PCLocalPublishView` (nueva o rama de
  `UploadScreen.kt` — decisión de detalle a tomar al implementar).
- Evaluar reuso de `VideoPlayerDialog.kt` para el preview LAN.
- Chip "Biblioteca LAN" en `LibraryScreen.kt`/`LibraryViewModel.kt`, mismo
  gate desacoplado de premium que iOS.
- **No se puede compilar Gradle desde este entorno Windows** (bug conocido
  de Claude Code en Windows con procesos hijos JVM, ver
  `UIEssePanel/CLAUDE.md` → "Trampas de entorno" — no es específico de este
  feature). Verificación real requiere que el usuario corra `./gradlew`
  desde Android Studio o una terminal normal y pegue la salida; no hay
  atajo por SSH equivalente al de iOS documentado para este repo.

### Fase 5 (opcional) — Unificar convenciones con Electron (sección 8)

- ✅ **Hecho 2026-08-16**: resuelta la pregunta de `/api/local/health` vs
  `api/health` — son endpoints distintos a propósito, no un mismatch (ver
  sección 8). `ServerConnectionPanel.tsx` alineado a `/api/health`, mismo
  contrato que `ServerHealthCheck.swift` en iOS. Verificado con lint+build
  del frontend, limpios. Commit `8c3b39d` en
  `feat/electron-lan-client-secondary` (rama sin mergear todavía).
- ⬜ Pendiente, no hecho en esta pasada: si se retoma la Opción C de
  Electron, copiar el nombre "Biblioteca LAN" para su UI también, en vez de
  dejarlo sin nombre definido — coherencia de producto entre
  desktop-secundaria y mobile.

### Fase 6 (pendiente, no arrancar sin que el usuario lo pida) — Descargar + Subir en modo Central

Dos pedidos explícitos del usuario, anotados para después de probar lo ya
implementado:

1. **"Descargar" en `PCLocalVideoDetailView`** (mismo botón que ya tiene
   `RemoteVideoDetailView` para Nube) — bajar los bytes del video de la PC
   al almacenamiento propio del teléfono, creando un `FileEntity` local.
   A diferencia de "Editar link"/toggle de estado (que solo exponían rutas
   que local-backend ya tenía), esto es una pieza de import nueva: no hay
   hoy un `ImportUseCase.importFromLAN(...)` equivalente a
   `importFromRemoteLibrary` — hay que diseñar de dónde saca los bytes
   (`LocalBackendUploadAPI.streamURL`, ya existe) y cómo dedupea contra lo
   que ya esté importado (mismo criterio que `ImportUseCase` ya usa para
   Nube, por nombre+duración+formato).
2. **"Subir" (pestaña, `PCLocalPublishView`/la cola completa) solo funciona
   en modo servidor "PC local"** — a diferencia de Biblioteca LAN (Videos),
   que ya es aditiva (funciona en modo Central + IP manual/Bonjour, sin
   cambiar de servidor). `UploadView.body` sigue gateando
   `PCLocalPublishView` detrás de `ServerPresetStore.activeMode == .pcLocal`
   exclusivamente (`UploadView.swift`) — nadie tocó esa condición en esta
   sesión. Si se quiere que la cola completa de "Subir" también sea aditiva
   en modo Central, es el mismo patrón que ya se aplicó a Biblioteca LAN
   (`activeLANBaseURL`/`LANLibraryPreferences`), pero aplicado a
   `UploadView` en vez de `LibraryView` -- no evaluado todavía si conviene
   fusionar ambos casos o mantenerlos separados.
