import { Schema, model, Document } from 'mongoose';
import { platformStateSchemaFields, IPlatformState } from '../utils/platform-state.util';

export type FileContentStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado';

// 'facebook': crossposting desde Instagram (ver instagram-upload.controller.ts,
// $addToSet: {platforms: ['instagram','facebook']}) escribía este valor sin que
// el enum lo declarara -- no bloqueaba la escritura ($addToSet no corre
// validadores por default), pero hacía pasar por "dato corrupto" a publicaciones
// reales de facebook en cualquier chequeo de integridad contra este enum
// (encontrado en la revisión independiente de docs/mongo-audit-2026-08-13.md,
// 2026-08-13). platform-video.model.ts ya lo tenía declarado.
export type Platform = 'youtube' | 'instagram' | 'tiktok' | 'facebook';

export interface IFile extends Document {
  userId?: string;       // dueño del archivo (scoping por cuenta). Legacy = sin dueño → backfill al owner.
  content_id?: string;   // identidad estable ante renombres/reimportaciones -- ver BackupFileModel y
                          // files.content_id en SQLite local. Registros viejos no lo tienen (partial).
  file_name: string;
  file_path: string;
  status: 'PENDIENTE' | 'PROCESANDO' | 'TRANSCRITO' | 'ELIMINADO_DISCO' | 'ERROR';
  content_status: FileContentStatus;
  platforms: Platform[];
  platforms_discarded: Platform[];
  // Estado explícito por plataforma (BUG-2026-08-15-03) -- `platforms`/
  // `platforms_discarded` siguen siendo la fuente de compatibilidad (arrays
  // planos que todo el resto del código ya lee), esto es la procedencia real
  // detrás de cada entrada de `platforms`: 'confirmed' (con platformId real,
  // ver applyPlatformPublish) vs 'badge_only' (marca manual/histórica sin
  // link). Sparse a propósito: registros viejos no lo tienen hasta la
  // migración (scripts/mongo-platform-states-migration.js).
  platform_states?: IPlatformState<Platform>[];
  publishCode?: string;  // código único para sync futuro — se incluye en descripción de YT/IG/TK
  duracion_segundos?: number;
  resolucion?: string;
  formato?: string;
  fecha_creacion?: Date;  // fecha real del archivo en disco (mtime) — la llena el escáner
  scheduled_date?: Date;  // fecha programada de publicación (opcional)

  // ── Metadata de sincronización (Entrega A, docs/mongo-collections-consolidation-plan-2026-09-02.md §2) ──
  // `files` absorbe estos campos para poder servir el mismo contrato que hoy
  // cubre `backup_files`, sin todavía cambiar qué colección leen los 4
  // endpoints de /api/backup (eso lo activa el flag BACKUP_CANONICAL_READS,
  // ver backup-file-canonical.service.ts). Todos opcionales a propósito:
  // ningún documento existente los tiene, y no hay migración/backfill en esta
  // entrega -- se completan solos con el próximo push de cada archivo.
  tipo_contenido?: string;          // categoría de guión/clip -- espejo de BackupFileModel.tipo_contenido.
  local_updated_at?: Date;          // última modificación general informada por el escritorio (push).
  platforms_updated_at?: Date;      // reloj dedicado de badges/descartes (SYNC-01 #3), igual que en BackupFileModel.
  backup_synced_at?: Date;          // cuándo la central aceptó el último push de backup para este archivo.
  backup_source_device_id?: string; // deviceId de la instalación que produjo ese último push aceptado.
}

const FileSchema = new Schema<IFile>({
  userId: { type: String, index: true },
  // Sin sparse acá -- el índice compuesto de abajo ya declara su propio
  // partialFilterExpression explícito (Fase 6, SYNC-02#1). Un `sparse: true`
  // a nivel de campo auto-creaba además un índice suelto {content_id:1} sin
  // declarar en ningún lado del código (encontrado en la auditoría de
  // 2026-08-31), redundante con el compuesto y sin beneficio real dado que
  // toda consulta real ya filtra por userId primero.
  content_id: { type: String },
  file_name: { type: String, required: true },
  file_path: { type: String, required: true },
  status: { type: String, required: true, enum: ['PENDIENTE', 'PROCESANDO', 'TRANSCRITO', 'ELIMINADO_DISCO', 'ERROR'] },
  content_status: {
    type: String,
    enum: ['publicado', 'borrador', 'procesando', 'descartado'],
    default: 'borrador',
  },
  platforms: {
    type: [String],
    enum: ['youtube', 'instagram', 'tiktok', 'facebook'],
    default: [],
  },
  platforms_discarded: {
    type: [String],
    enum: ['youtube', 'instagram', 'tiktok', 'facebook'],
    default: [],
  },
  platform_states: {
    type: [platformStateSchemaFields],
    default: undefined, // no default [] a propósito -- distingue "nunca migrado" de "migrado, sin estados"
  },
  publishCode: { type: String, sparse: true },
  duracion_segundos: { type: Number },
  resolucion: { type: String },
  formato: { type: String },
  fecha_creacion: { type: Date },
  scheduled_date: { type: Date },
  tipo_contenido: { type: String },
  local_updated_at: { type: Date },
  platforms_updated_at: { type: Date },
  backup_synced_at: { type: Date },
  backup_source_device_id: { type: String },
}, { timestamps: true });

// Único por usuario + content_id (Fase 6, SYNC-02#1, 2026-08-31) -- antes
// era sparse y NO único (permitía duplicados). Se subió a único recién
// después de reconciliar una divergencia histórica real entre files/
// backup_files (1033 registros con content_id distinto para el mismo
// archivo, causa: un wipe/reinstalación del 2026-06-26 -- ver
// docs/SYNC-01-audit-2026-08-30.md), migrada con
// backend/scripts/mongo-content-id-reconcile-backup-files.js antes de
// poder subir este índice sin que fallara. partialFilterExpression
// explícito en vez de `sparse` (mismo patrón ya probado en producción por
// remote-library-video.model.ts) -- sparse en un índice compuesto excluye
// el documento si CUALQUIERA de los dos campos falta, lo cual acá coincide
// con lo que queríamos, pero es un comportamiento implícito/frágil frente
// a declarar explícitamente qué documentos entran al índice.
FileSchema.index(
  { userId: 1, content_id: 1 },
  { unique: true, partialFilterExpression: { content_id: { $type: 'string' } } },
);

// Único por usuario, no global (2026-08-13, ver docs/mongo-audit-2026-08-13.md):
// antes file_path era único GLOBAL (índice creado fuera del schema, nunca
// declarado acá) y ya colisionaba en producción -- el flujo de backup crea
// filas con file_path = file_name como placeholder (resolveOrCreateFile en
// backup.controller.ts), así que dos usuarios con el mismo nombre de archivo
// (ej. "render.mp4") pisaban el índice global. Migrado a este compuesto vía
// backend/scripts/mongo-filepath-index-and-normalize.js (0 duplicados por
// (userId,file_path) verificado antes de aplicar).
FileSchema.index({ userId: 1, file_path: 1 }, { unique: true });

export const FileModel = model<IFile>('File', FileSchema, 'files');