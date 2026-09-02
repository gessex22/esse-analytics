# Product backlog

## Instagram sin Página de Facebook

- [ ] Soportar dos formas de conexión de Instagram:
  - Instagram Login para cuentas profesionales sin Página de Facebook.
  - Facebook Login for Business para usuarios que quieran vincular Instagram y Facebook.
- [ ] Mantener publicación y métricas de Instagram en ambos flujos.
- [ ] Mostrar en la interfaz qué funciones adicionales habilita la conexión con Facebook.

## Backend central listo para producción

**Estado:** pendiente, relevado el 2026-09-01. La central pública responde y
ya tiene Helmet, CORS restringido, rate limiting, logs de login y eventos de
auditoría, pero todavía no alcanza la barra de producción pública/pagos.

### P0 — seguridad antes de exponer a más usuarios

- [ ] Hacer obligatorios `JWT_SECRET`, `CLIENT_REGISTER_KEY` y el resto de
  secretos críticos; validar configuración al arrancar y eliminar fallbacks de
  desarrollo en producción.
- [ ] Corregir `POST /api/auth/register`: validar realmente
  `X-Client-Key` en vez de aceptar cualquier valor distinto de
  `__disabled__`.
- [ ] Firmar el `state` de OAuth, agregar expiración, nonce de un solo uso y
  protección contra replay para YouTube, Instagram y TikTok.
- [ ] Revalidar en servidor que el usuario siga activo y que conserve
  rol/tier/entitlements; definir revocación de JWT al dar de baja o reducir
  permisos.
- [ ] Agregar middleware global de errores, fijar `NODE_ENV=production` y no
  devolver stack traces, rutas físicas ni `err.message` internos al cliente.
- [ ] Actualizar dependencias vulnerables y dejar `npm audit` sin hallazgos
  altos/críticos aplicables.

### P1 — calidad y observabilidad

- [ ] Agregar pruebas automatizadas de auth, ownership multiusuario, roles,
  OAuth y rutas destructivas; hacer bloqueante el typecheck del backend en CI.
- [ ] Resolver el baseline actual de TypeScript (27 errores al relevarlo).
- [ ] Incorporar logging estructurado con request ID, nivel, endpoint, estado,
  latencia y contexto sanitizado; nunca registrar JWT, tokens OAuth, secretos o
  rutas completas de archivos del usuario.
- [ ] Centralizar excepciones y agregar métricas/alertas de disponibilidad,
  errores 5xx, latencia, MongoDB, disco y fallos de tareas de retención.
- [ ] Definir health/readiness separados, cierre ordenado (`SIGTERM`), manejo de
  errores no capturados y un proceso de despliegue reproducible que no dependa
  de ejecutar TypeScript con dependencias de desarrollo.
- [ ] Documentar y probar backup/restauración de MongoDB y de los bytes de la
  Biblioteca remota; distinguirlo del backup funcional de los clientes.

**Regla de entrega:** implementar en cambios pequeños y reversibles, validar
primero en staging y desplegar este hardening separado de cualquier migración
de colecciones.

## Consolidación de colecciones MongoDB

**Estado:** pendiente, agregado el 2026-09-01. Esto es distinto de la
reconciliación de `content_id`, que ya quedó cerrada y blindada el 2026-08-31
(ver `docs/SYNC-01-audit-2026-08-30.md`). Todavía no se fusionaron físicamente
las colecciones que representan datos relacionados.

### Primera entrega recomendada

- [x] Diseñar una colección canónica para `files` + `backup_files`, definiendo
  qué campos pertenecen al catálogo central y cuáles son estado por
  dispositivo/backup. Diseño: `files` queda como canónica; `backup_files` se
  retira con un **snapshot único pre-migración** (no shadow-write en vivo de
  30 días — ya es redundante hoy, ver sección 1 del plan) y se apaga apenas
  el postflight del `--apply` global pasa.
- [x] Inventariar todos los lectores y escritores en backend central,
  local-backend, Electron, iOS y Android antes de cambiar el contrato. Ver
  `docs/mongo-collections-consolidation-plan-2026-09-02.md`.
- [ ] Mantener compatibilidad temporal de API (adaptador o dual-read/dual-write)
  para que clientes instalados de versiones anteriores no se rompan.
- [ ] Crear migración con dry-run por defecto, snapshot previo obligatorio de
  `backup_files`, actualizaciones condicionadas, postflight automático y
  rollback generado desde el snapshot.
- [ ] Ejecutar primero una muestra pequeña y verificar push, pull, wipe+restore,
  renombre, calendario, Matches, Estadísticas, Historial y Biblioteca remota.
- [ ] Retirar `backup_files` inmediatamente después del postflight exitoso del
  `--apply` global — sin ventana de observación adicional, dado que el
  snapshot ya cubre el rollback.

### Renombre de colecciones inconsistentes (documentado, separado de la consolidación)

- [x] Relevar las 16 colecciones reales y proponer nombres consistentes:
  `platformvideos`→`platform_videos`, `loginlogs`→`login_logs`,
  `ideacentrals`→`ideas_centrales`, y `platform_config` (sin modelo, sin
  índice único hoy) → modelo Mongoose real `platform_configs` con índice
  único `{userId, platform}`. Ver sección 9 del plan.
- [ ] Ejecutar el renombre (`renameCollection` + actualizar cada modelo/script
  que la referencia) como entrega separada, después de que la consolidación
  de `files`/`backup_files` esté estable.

### Familias posteriores a evaluar (no fusionar automáticamente)

- [ ] Definir la semántica canónica entre `platformvideos`,
  `backup_platform_videos` y `upload_history`; hoy vínculo/métricas, espejo de
  recuperación y último evento no son necesariamente la misma entidad.
- [ ] Evaluar `transcripts` + `transcript_backups` con el mismo protocolo de
  compatibilidad y migración reversible.
- [ ] Confirmar cero consumidores y eliminar las colecciones legacy
  `publishing_status` y `published_cards` mediante una migración separada.
- [ ] Documentar qué colección queda como fuente de verdad, cuál es historial
  append-only y qué datos siguen siendo locales por dispositivo.

**Regla de entrega:** desarrollar en un worktree/branch separado del hardening
de seguridad y no ejecutar una migración de datos al mismo tiempo que el
despliegue de autenticación.
