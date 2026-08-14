# Plan de implementación: instalación primaria segura + subida ad-hoc

Plan de ejecución concreto para `docs/single-primary-install-plan-2026-08-14.md`
(que quedó en nivel de diseño). Escrito en conversación 2026-08-14,
revisado y con una corrección de contrato aplicada antes de empezar. **Sin
implementar todavía** — este documento es la especificación a seguir.

## Antes de leer las fases: 2 hallazgos que suben la prioridad de Fase 0

Verificados contra el código real, no son teóricos:

1. **`POST /api/auth/link-install` (`backend/src/controllers/auth.controller.ts:298-310`)
   hoy pisa `User.installId` en CADA login, sin condición.** Se llama desde
   `local-backend/src/routes/local-admin.routes.ts:87-121` (`/api/local/owner`,
   que corre en cada inicio de sesión). O sea: `installId` hoy no es "la
   primera instalación", es literalmente "la última PC que inició sesión" —
   el campo que autoriza reset de contraseña y baja de cuenta cambia de
   dueño solo con loguearse en otra máquina. Es un bug de seguridad real,
   no una mejora cosmética. **Prioridad inmediata, independiente de todo lo
   demás de este plan.**
2. **`bulkUpsertBackupFiles` (`backend/src/controllers/backup.controller.ts:330`)
   hace `if (req.body.fullSync === true)` — la central confía ciegamente en
   el booleano que manda el cliente**, sin validar contra quién es
   realmente la primaria. Cualquier instalación puede mandar
   `fullSync: true` hoy y archivar el catálogo de otra. Fase 1.2 lo cierra.

## Fase 0 — Corregir el contrato de "primaria"

Objetivo: que una instalación secundaria no pueda convertirse en primaria
ni hacer un `fullSync` por accidente.

1. Separar el endpoint actual `link-install`:
   - Si `User.installId` está vacío, registra la primera instalación.
   - Si ya tiene valor distinto, responde con estado `secondary`; **no lo
     reemplaza** (arregla el hallazgo #1 de arriba).
   - Nunca reasigna la primaria automáticamente al iniciar sesión.
2. Crear `POST /api/local/claim-primary`.
   - Requiere JWT, `installId` local y confirmación explícita.
   - Requiere reautenticación reciente o contraseña actual.
   - Cambia `User.installId`.
   - Guarda evento de auditoría (`recordAuditEvent`, ya existe en
     `services/audit.service.ts`): instalación previa, nueva, fecha y origen.
   - Devuelve el rol final: `primary` o `secondary`.
3. Crear un endpoint de estado, `GET /api/local/installation-status`:
   ```json
   {
     "role": "primary",
     "canFullSync": true,
     "canManageFolder": true,
     "canUseAdHocUpload": true
   }
   ```

## Fase 1 — Aplicar el gate en servidor y cliente

Objetivo: que el bloqueo no dependa solo de la UI.

1. Cada llamada local relevante incluye `installId`: `/api/backup/files/bulk`,
   configuración de carpeta, cualquier ruta que ejecute escaneo, watcher o
   reconciliación.
2. La central compara `installId` con `User.installId`.
   - Solo la primaria puede enviar `fullSync: true`.
   - La secundaria recibe `403 PRIMARY_INSTALL_REQUIRED` si intenta
     sincronizar catálogo, crear identidad persistente o modificar la
     carpeta.
   - **La central ignora el booleano `fullSync` enviado por el cliente: lo
     calcula según la instalación validada** (arregla el hallazgo #2).
3. En Electron/local-backend:
   - Al login y antes de cada sync, consulta el estado.
   - Si es secundaria: detiene watcher, escaneo y setup de carpeta.
   - La UI oculta catálogo local, Taller y Gemas (mismo criterio que
     `LOCAL_ONLY_NAV` en modo remoto).
   - Muestra banner con "Reclamar esta PC como principal".

## Fase 2 — Hacer segura la subida ad-hoc

Objetivo: que una secundaria pueda publicar un archivo puntual sin crear
matches por nombre incorrectos.

1. Crear `POST /api/local/ad-hoc-upload/prepare`:
   - El usuario selecciona un archivo mediante picker nativo.
   - Se copia a un temporal controlado.
   - Se crea una fila SQLite marcada `ad_hoc = true`.
   - Genera un `content_id` para esa operación (nunca colisiona — es un
     archivo nuevo, sin conflicto posible, ver
     `single-primary-install-plan-2026-08-14.md` sección "Video nuevo en
     la secundaria").
2. Reusar uploaders existentes (`youtube-upload.controller.ts` etc., que ya
   exigen `fileId` de SQLite) con ese `fileId` temporal — sin tocarlos.
3. Cambiar `resolveOrCreateFile` en central — **contrato corregido, ver
   sección siguiente**.
4. Para registros ad-hoc, usar un `file_path` placeholder que nunca
   colisione: `adhoc://<installId>/<contentId>`. **No** usar
   `file_path = file_name` (el patrón que causó H2/el bug de colisión
   global que ya se arregló para el catálogo normal, pero que
   `resolveOrCreateFile` sigue hardcodeando en su `$setOnInsert` — hay que
   parametrizarlo para este caso).
5. Al finalizar:
   - Se conserva el registro central para Historial, badges y estadísticas.
   - Se borra el temporal local.
   - El registro SQLite ad-hoc se elimina o se marca como expirado.
   - Miniatura queda fuera de alcance inicial (mejora opcional futura, ver
     el doc de diseño).

### Contrato corregido de `resolveOrCreateFile` (bloqueante de Fase 2, ya resuelto)

**Hallazgo que bloqueaba esto:** la primera versión de la regla decía "sin
`contentId`, 0 candidatos → no enlazar automáticamente", lo cual —tal como
estaba escrita— habría roto el flujo actual de `recordPublish` en
iOS/Android (que **nunca manda `contentId`**, confirmado leyendo
`SyncAPI.swift`/Android) para el caso normal de "primera publicación de un
video nuevo desde el celular" (0 candidatos por nombre, hoy crea un
registro mínimo — comportamiento shippeado que no se puede romper).

**Distinción clave que resuelve la ambigüedad**: "no enlazar" significa
"no atribuir el evento a un archivo *existente* ambiguo"; nunca significa
"rechazar o perder una publicación nueva". Contrato final:

```
Si llega contentId:
  buscar SOLO por (userId, content_id)
  - 1 candidato: vincular
  - 0 candidatos: crear un FileModel nuevo
  - nunca hacer fallback por fileName

Si NO llega contentId:
  buscar por fileName
  - 0 candidatos: crear un FileModel mínimo nuevo   ← obligatorio para mobile
  - 1 candidato: vincular
  - más de 1 candidato: NO vincular automáticamente;
    crear un registro mínimo independiente (no perder el evento),
    con un file_path sintético único: mobile://<platform>/<platformId>
    (evita tanto el match incorrecto -- H9 -- como la colisión del
    índice de file_path)
```

Esto aplica a **todos** los callers de `resolveOrCreateFile`
(`recordPublish`/`applyPlatformPublish`, `updateFilePlatforms`, y la nueva
subida ad-hoc), no solo a la subida ad-hoc — es el contrato general de la
función.

## Fase 3 — Resolver C4 antes del índice

Objetivo: definir qué significa un rename y evitar que `file_name` sea una
identidad.

1. Mantener `file_name` como dato de presentación, no como clave de
   identidad.
2. Revisar `backup_files`:
   - Retirar gradualmente la unicidad `{userId, file_name}`.
   - Sustituirla por un índice no único de consulta si hace falta.
   - Conservar la unicidad futura en `{userId, content_id}` con filtro
     parcial.
3. Reglas de conflicto:

   | Situación | Acción |
   |---|---|
   | Mismo `content_id`, nombre nuevo | Renombre: actualizar el nombre. |
   | Mismo nombre, `content_id` distinto | Dos archivos: conservar ambos; no fusionar (arregla H9). |
   | Sin `content_id`, un candidato por nombre | Permitir enlace legado. |
   | Sin `content_id`, cero candidatos | Crear nuevo (ver contrato de Fase 2). |
   | Sin `content_id`, varios candidatos | Crear registro mínimo independiente, no vincular automático. |

## Fase 4 — Migración e índices

Solo tras implementar las fases anteriores:

1. Desplegar código y modelos juntos; `autoIndex` exige que esto sea
   atómico (evita el problema de H4: mongoose recreando un índice viejo
   solo si el modelo no se actualiza en el mismo deploy).
2. Ejecutar preflight de solo lectura: duplicados por `(userId,content_id)`,
   documentos sin `content_id`, casos de mismo nombre con IDs distintos.
3. Crear índices únicos parciales **con nombre distinto al sparse
   existente** (`userId_1_content_id_1` ya existe como sparse no-único —
   ver H3 de `docs/mongo-remediation-review-2026-08-13.md`, no se puede
   reemplazar en el lugar):
   ```js
   db.files.createIndex(
     { userId: 1, content_id: 1 },
     { unique: true, partialFilterExpression: { content_id: { $type: "string" } },
       name: "userId_1_content_id_unique" }
   )
   ```
   Igual en `backup_files`.
4. Retirar el índice único por nombre de `backup_files` tras validar que
   ningún flujo depende de él.
5. Guardar resultados de preflight y comandos de rollback (mismo patrón
   que `backend/scripts/mongo-p0-index-fixes.js`).

## Fase 5 — Pruebas obligatorias

Automatizadas (central):
- Secundaria no puede hacer `fullSync`.
- Login secundario no reemplaza la primaria.
- Claim explícito sí cambia la primaria y deja auditoría.
- Subida ad-hoc con mismo nombre y distinto `content_id` no se fusiona.
- Rename con mismo `content_id` sí conserva enlaces.
- Conflicto de índice no aborta el backup completo (ya cubierto en parte
  por C1, `bulkWrite({ordered:false})`, commit `26440e3`).
- Usuario free no obtiene capacidades de Biblioteca remota.

Manuales:
- Primaria: push → wipe → pull.
- Secundaria: login, gate, subida ad-hoc en YouTube/Instagram/TikTok.
- Cambio de primaria.
- Dos PCs con mismos nombres de archivo.
- iOS y Android publicando con y sin `contentId`.

## Orden de ejecución

Endurecer autoridad de primaria (Fase 0-1, **prioridad inmediata por los 2
hallazgos de seguridad**) → corregir matching ad-hoc/por nombre (Fase 2,
contrato ya resuelto arriba) → decidir C4 (Fase 3) → crear índice (Fase 4)
→ pruebas (Fase 5, en paralelo desde el principio donde aplique).
