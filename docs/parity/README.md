# Paridad funcional entre plataformas

EsseAnalytics tiene tres clientes independientes (Electron/web, Android, iOS) que
hablan con la misma central. Cada uno se programó por separado y con el tiempo
aparecen huecos: una función se agrega en una plataforma y se olvida en las otras.

Esta carpeta es la fuente única de verdad para evitar eso. Tres archivos:

- **`features.yaml`** — catálogo maestro de funcionalidades y su estado en cada
  plataforma (`implemented: true|false|partial`).
- **`api_matrix.yaml`** — qué endpoint real llama cada plataforma, verificado
  contra el código (no contra lo que "debería" llamar).
- **`permissions.yaml`** — permisos de SO que declara cada plataforma.

## Cómo se armó (2026-07-23)

Auditoría real, no supuesta: rutas del backend confirmadas por grep directo de
`backend/src/routes/*.ts`; llamadas de Android confirmadas leyendo las 5
interfaces Retrofit en `core/network/.../api/*.kt`; llamadas de iOS confirmadas
leyendo `Core/Network/*.swift` + cada `Features/*/*.swift` que hace networking.
Los permisos salen de `AndroidManifest.xml` e `Info.plist` directamente.

## Cómo mantenerla al día

- Al agregar un endpoint nuevo en el backend: agregarlo a `api_matrix.yaml` con
  `false` en las plataformas que todavía no lo consumen.
- Al agregar una función nueva en cualquier plataforma: agregar (o actualizar)
  su entrada en `features.yaml` con un `id` estable.
- Antes de dar por "completa" una función, confirmar que las 3 filas de
  `api_matrix.yaml` para sus endpoints estén en `true` (o justificar por qué no
  aplica, ej. algo local-only de la PC).

## Pendiente (fase 2, no hecho todavía — requiere más lectura de código)

Specs funcionales por feature (`FEATURE-XXX`: flujo pantalla→API→UI, errores
manejados, timeouts/reintentos) para las funciones de Prioridad 1 y 2 del
punchlist. No se inventó nada acá — se deja para cuando se ataque cada una,
así la spec se escribe junto con el fix y queda verificada, no supuesta.
