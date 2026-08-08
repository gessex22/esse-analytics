# Auditoría de flujos que vive una persona

Fecha de revisión: 2026-08-05. Esta auditoría sigue el recorrido de una persona
entre Desktop, iPhone, Android y nube. No evalúa si una llamada técnica existe
solamente; evalúa si el resultado queda claro, completo y consistente para quien
usa la aplicación.

## Resumen ejecutivo

La aplicación ya tiene las piezas principales para publicar, consultar el
calendario, usar nube y sincronizar. El problema predominante no es que falte
una API: es que las tres aplicaciones no terminan el mismo recorrido de la
misma forma. Desktop suele cerrar el ciclo; móvil suele poder iniciar o consultar
el proceso, pero no siempre puede terminarlo, revisarlo o saber quién cambió
el resultado.

| Prioridad | Hueco para la persona usuaria | Dónde se nota |
|---|---|---|
| P0 | Una publicación puede terminar sin una confirmación clara y, al salir, el estado queda ambiguo. | iOS y Android; el historial central puede quedar retrasado. |
| P0 | No existe una vista móvil para revisar el historial completo de publicaciones. | iOS y Android. |
| P0 | No se puede saber con certeza qué dispositivo hizo un cambio en nube/calendario/enlaces. | Las tres plataformas. |
| P1 | El calendario móvil enseña qué sigue, pero no ofrece el mismo control que Desktop para ordenar o ajustar la agenda. | iOS y Android. |
| P1 | El badge «Próximo» puede dejar de coincidir cuando dos videos comparten nombre o están en otro dispositivo. | Las tres plataformas, especialmente móvil/nube. |
| P1 | TikTok puede fallar al cargar más resultados sin explicar qué pasó. | Desktop, iOS y Android a través de la central. |
| P2 | La nube protege el siguiente video que conoce una PC; si ese siguiente solo existe en un móvil, no hay un camino automático para prepararlo. | Nube y móvil. |

## 1. «¿Qué video me toca publicar ahora?»

### Recorrido real

1. La persona abre Calendario, Videos o Subir.
2. La aplicación pregunta a la central cuál es el próximo video de YouTube,
   Instagram y TikTok.
3. La central mira primero si alguien fijó un video manualmente. Si ese video
   ya se publicó, se descartó o se eliminó, elige el pendiente más antiguo.
4. Desktop guarda una copia local de esa respuesta. iOS y Android la usan para
   marcar el video con el badge «Próximo».
5. Si una PC tiene el archivo, intenta dejar una copia en Nube para que el
   próximo se pueda usar también desde móvil.

### Lo que funciona

- La central es quien decide el próximo; eso evita que cada dispositivo invente
  un orden distinto.
- Al confirmar una publicación, la central actualiza el estado y puede calcular
  otra vez qué sigue.
- iOS y Android ya muestran el próximo en Biblioteca/Subir cuando pueden hacer
  coincidir el video local con la respuesta central.

### Huecos encontrados

**Control desigual.** Desktop puede fijar el siguiente y cambiar el intervalo.
Android tiene el contrato de red preparado, pero su pantalla Calendario solo
consulta; iOS consulta y puede «saltar» el actual, pero no tiene el editor
completo. Para una persona, el mismo calendario ofrece permisos y acciones muy
distintas según el dispositivo.

**Badge por nombre.** En móvil, el badge compara el título/nombre que llega de
la central con el nombre del archivo local. Si existen dos videos con el mismo
nombre, se renombra un archivo o el video está solo en otra biblioteca, el badge
puede faltar o aparecer en el video equivocado. Hay `contentId` y el id de
Biblioteca remota como mejores referencias, pero no son la llave uniforme de
punta a punta en todas las pantallas.

**Nube condicionada a una PC.** La precarga del próximo nace en el backend local
de Desktop. Si el próximo existe solamente en un teléfono, el calendario puede
decir que ese es el siguiente, pero Nube no puede prepararlo automáticamente
para el otro teléfono. Esto no debe publicar desde la central: solo debe dejar
claro «este siguiente aún no está disponible en nube» y permitir subirlo a Nube
de forma explícita.

### Resultado que debería existir

En cualquier dispositivo: «Para TikTok te toca *Video X*. Está disponible en
este dispositivo / está disponible en Nube / solo existe en otro dispositivo».
Y para quienes tengan permiso: las mismas acciones para fijar, saltar o cambiar
la cadencia, con una explicación de cómo afectará el siguiente.

## 2. «Publico un video y quiero saber que terminó bien»

### Recorrido real

1. La persona elige un video y una o varias plataformas.
2. El dispositivo pide a la central el token de la plataforma.
3. Desktop, iOS o Android envían el video directamente a YouTube, Instagram o
   TikTok; la central no envía ese video por cuenta del usuario.
4. Tras confirmación, se actualizan el video local, la relación con la
   plataforma, el calendario y el registro central.

### Lo que funciona

- La publicación directa está presente en los tres clientes.
- Android usa trabajos del sistema para ejecutar una publicación por plataforma.
- iOS y Android notifican a la central el resultado y Desktop también lo hace.
- La central aplica el resultado a `FileModel` y `PlatformVideoModel`, por lo
  que el calendario puede avanzar incluso si el origen fue móvil.

### Huecos encontrados

**Final poco visible.** El resultado existe por plataforma, pero el formulario
no tiene un final consistente entre dispositivos: éxito total, éxito parcial,
error y reintento no guían a la persona de la misma manera. Esto coincide con
el problema reportado: hoy se ve texto o un icono pequeño cuando debería haber
una confirmación clara y una vuelta natural a Inicio.

**Salida de la app.** iOS ejecuta la carga en una tarea de primer plano y la
isla dinámica refleja esa tarea. Al dejar la app, no hay una promesa confiable
de que continúe ni una transición de estado clara para la persona. Android
tiene WorkManager, pero el resultado de ese trabajo no se resume como un lote
visible cuando se vuelve a la pantalla. El hueco no es «faltan bytes»: falta un
estado humano común: *subiendo*, *procesando*, *interrumpida*, *terminó* o
*necesita reintento*.

**Registro posterior es mejor esfuerzo.** La plataforma puede aceptar el video
y después fallar el aviso a la central por red. El video existe publicado, pero
calendario, historial y estadísticas pueden tardar en enterarse. Hace falta una
cola local de avisos pendientes y una pantalla/indicador «publicado, pendiente
de sincronizar» en lugar de silencio.

**Riesgo de duplicado al reintentar.** TikTok ya contiene comentarios defensivos
porque una confirmación incierta puede llevar a volver a enviar el video. El
reintento debe partir de un `operationId`, comprobar primero si la publicación
ya fue confirmada y pedir decisión de la persona si existe duda.

### Resultado que debería existir

Un único resumen por lote: qué redes terminaron, cuáles no, si la central ya
recibió el resultado y qué acción concreta toca. Si se sale de la app: «Subida
interrumpida en Instagram, 62 %. Vuelve para reintentar»; nunca una isla o una
pantalla aparentemente congelada.

## 3. «Quiero consultar lo que publiqué»

### Recorrido real

1. Desktop registra y consulta el historial completo, con filtros y páginas.
2. iOS y Android sí conocen el último evento para mostrarlo en Inicio.
3. Ambos móviles también pueden registrar publicaciones por el alias de
   compatibilidad `record-publish`, que hoy sí existe en la central.

### Hueco encontrado

En móvil falta la pantalla de Historial: no se puede recorrer publicaciones
anteriores, filtrar por red, abrir enlaces ni entender desde qué dispositivo se
publicó. No es un hueco de datos; es un hueco de recorrido y de interfaz.

La matriz de paridad anterior dice que Android/iOS no reportan historial, pero
el código actual ya llama `recordPublish`. La conclusión correcta hoy es:
**el registro existe parcialmente, la experiencia de historial móvil no**.

### Resultado que debería existir

Una opción Historial en Más: fecha, red, video, estado, enlace, dispositivo y
filtro por plataforma. Debe refrescarse después de publicar y mostrar «pendiente
de sincronizar» cuando corresponda.

## 4. «Quiero saber quién cambió algo»

### Recorrido real

Una publicación o un cambio manual puede tocar estado local, la central, la
Biblioteca remota, enlaces entre plataformas y calendario. Hoy se conoce el
usuario y a veces el campo `source`, pero no hay una bitácora uniforme de cada
instalación y cada cambio.

### Hueco encontrado

Ante un video que cambia de estado no se puede responder de forma confiable:
«lo cambió este iPhone, a esta hora, desde esta versión de la app». Tampoco se
puede distinguir con facilidad una acción manual de una sincronización o un
reintento.

### Resultado que debería existir

Una bitácora central no editable con: dispositivo con nombre, instalación,
usuario, fecha del servidor, acción, video afectado, antes/después y un
identificador que una todos los pasos de una misma publicación. No debe incluir
tokens, rutas privadas ni archivos.

## 5. «Quiero emparejar videos entre plataformas»

### Recorrido real

1. La central consulta videos recientes de cada red.
2. Muestra candidatos para unir YouTube, Instagram y TikTok al mismo contenido.
3. La persona puede vincular, marcar huérfano o elegir manualmente.
4. El resultado actualiza los vínculos centrales y luego se refleja en las
   bibliotecas locales.

### Hueco encontrado

El caso TikTok «Cargar más» tiene un problema de confianza: el backend trata
varios fallos como una lista vacía. Para la persona, botón inactivo, token
vencido y fin real de lista se ven igual. Además, la matriz anterior marca iOS
incompleto, pero la vista actual ya tiene una implementación de selección y
carga de más; el problema es el diagnóstico de error, no solo la ausencia de
botón.

### Resultado que debería existir

«No hay más videos» solo cuando realmente no los hay. Para token vencido,
permiso o cursor inválido: explicar el problema y ofrecer Reconectar o
Reintentar, sin borrar los resultados ya visibles.

## 6. «Guardo un video en Nube y lo uso desde otro dispositivo»

### Recorrido real

1. Desktop e iOS usan TUS para enviar una copia reanudable a Nube.
2. Android actual ya tiene una ruta de TUS en `RemoteLibraryViewModel`; la
   documentación de paridad que decía que Android usaba una ruta inexistente
   está desactualizada.
3. Nube guarda metadata, miniatura y, cuando aplica la retención, conserva los
   bytes principalmente de los siguientes videos del calendario.
4. Un móvil puede importar una copia remota y luego publicar directamente.

### Huecos encontrados

**Disponibilidad no explicada.** Un video puede aparecer en Nube con metadata
pero sin bytes porque la retención los liberó. El código maneja parte de este
caso, pero el mensaje debe ser uniforme: no es «video roto», es «la copia para
publicar ya no está disponible; súbela de nuevo desde el dispositivo que la
tiene».

**Identidad del contenido.** Sigue habiendo rutas de emparejamiento por nombre
de archivo como respaldo. Es útil para datos viejos, pero no debe decidir una
acción destructiva ni un badge sin advertir ambigüedad.

## Orden recomendado de reparación

1. **Cerrar el ciclo de publicación móvil:** estado de lote visible, éxito
   total/parcial, interrumpida, reintento y cola de avisos pendientes de enviar
   a la central.
2. **Historial + bitácora de dispositivo:** permite ver y explicar qué pasó.
3. **Calendario coherente en móvil:** control según rol, disponibilidad del
   próximo y badges basados en identificador estable.
4. **Errores explícitos de TikTok y sincronización:** no confundir fallo con
   lista vacía.
5. **Nube explicable:** indicar disponibilidad real de bytes y por qué una copia
   no está disponible.

## Evidencia principal revisada

- Central: `backend/src/controllers/sync.controller.ts` y
  `backend/src/controllers/backup.controller.ts`.
- Desktop: `local-backend/src/services/calendar-sync.service.ts`, controladores
  de publicación y `frontend/src/components/PublishingQueue.tsx`.
- iOS: `Features/Upload`, `Features/Calendar`, `Features/Library`,
  `Features/Sync` y `Core/Network/SyncAPI.swift`.
- Android: `feature/upload/UploadWorker.kt`, `UploadViewModel.kt`,
  `feature/calendar/CalendarViewModel.kt`, `feature/library` y `core/network`.
