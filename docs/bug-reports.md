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
