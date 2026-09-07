# Medición inicial de sincronización

Primera etapa de BUG-2026-09-05-01. No cambia frecuencia, reglas de conflictos,
precarga ni respuestas HTTP de la aplicación.

## Obtener una muestra

En PowerShell, desde `local-backend`, iniciar el backend con:

```powershell
$env:ESSE_SYNC_METRICS = '1'
npm run dev
```

Usar este arranque solo si no hay otro backend/Electron ocupando el puerto 4000.
Para observar Electron en desarrollo, definir la misma variable en la terminal
desde la que se ejecuta `npm run dev` en `electron`, sin arrancar además otro
backend. Los registros aparecen en la terminal con prefijo `[sync-metrics]`.
Cerrar ese proceso y quitar la variable para desactivar:

```powershell
Remove-Item Env:ESSE_SYNC_METRICS
```

Registrar muestras sin cambios, después de un descarte desde móvil y después
de una publicación. Confirmar por separado si el estado llegó a central, a
SQLite y a la vista. La instrumentación no genera solicitudes adicionales:
solo observa las que ya realiza el controlador de backup.

## Interpretación

- `backup_http`: ruta sin query ni host, método, status, éxito HTTP, bytes JSON
  enviados, bytes recibidos descomprimidos y tiempo hasta consumir la respuesta.
- `pull_catalog_applied`: tiempo del bucle de reconciliación del catálogo en
  SQLite y cantidades de registros actualizados, recuperados, omitidos y sin
  correspondencia. No incluye la recuperación posterior de configuración o
  vínculos de publicaciones; sus descargas sí tienen registros HTTP separados.
- `failure: transport_or_body`: fallo de red o lectura de respuesta; la excepción
  original continúa hacia el manejo existente. Un 2xx no demuestra que todos los
  registros se aplicaron: contrastar el resumen de reconciliación.

No se registran cuerpos, títulos, identificadores de usuario ni tokens. Los
bytes no incluyen cabeceras y no equivalen al tráfico comprimido ni facturable.
No mide consultas individuales de Mongo, CPU, precarga, videos ni miniaturas.
Con el flag activo se mantiene en memoria la respuesta JSON completa para medir
su tamaño; usar sesiones acotadas de diagnóstico. Comparar varias muestras y
evitar inferir capacidad del servidor a partir de una sola ejecución.

Validación automatizada: `npx --no-install tsx --test
src/services/sync-metrics.service.test.ts` desde `local-backend` (en una línea).
Cubre UTF-8, privacidad, respuestas 403/204, fallos de red y modo desactivado.

Siguiente etapa: separar controles de ejecución, actualizar vistas tras el pull,
eliminar consultas redundantes y ajustar el respaldo periódico con las muestras.
