// Lectura canónica de los 4 endpoints de /api/backup a partir de `files`
// (FileModel) exclusivamente, sin tocar `backup_files` (BackupFileModel).
//
// Entrega A de docs/mongo-collections-consolidation-plan-2026-09-02.md: esto
// existe para poder comparar (Entrega C) y eventualmente reemplazar
// (Entrega D) el camino viejo de backup.controller.ts, que hoy mergea
// BackupFileModel + FileModel a mano en cada endpoint. Mientras
// BACKUP_CANONICAL_READS no esté en 'true', nada de este archivo se ejecuta
// en producción -- ver el flag en backup.controller.ts.
//
// Contrato a preservar (docs/mongo-collections-consolidation-plan-2026-09-02.md §3):
// GET /api/backup/files (incl. ?includeResolved=true), POST /api/backup/files/bulk,
// GET /api/backup/status, GET /api/backup/sync-status. Este servicio cubre las
// 3 lecturas; el bulk de escritura sigue en backup.controller.ts sin cambios.
import { FileModel } from '../models/file.model';
import { UserModel } from '../models/user.model';

// Mismo shape que ya devuelve GET /api/backup/files hoy (ver getBackupFiles):
// el DTO iOS legacy (BackupFileDTO.swift) exige _id/createdAt no-opcionales,
// el consumidor activo (pull de Electron) usa content_id/local_updated_at/
// platforms_updated_at. A diferencia del camino viejo, acá TODO archivo trae
// _id/createdAt/content_id/tipo_contenido siempre -- el camino viejo solo los
// completa para lo que pasó por BackupFileModel ("onlyInCentral" quedaba sin
// content_id/tipo_contenido, ver comentario de getBackupFiles). Diferencia
// intencional y explicable para la comparación de la Entrega C, no un bug.
export interface CanonicalBackupFileDto {
  _id: unknown;
  createdAt: Date;
  file_name: string;
  content_id: string | null;
  platforms: string[];
  platforms_discarded: string[];
  platform_states: unknown[];
  content_status: string;
  tipo_contenido: string | null;
  scheduled_date: Date | null;
  duracion_segundos: number | null;
  resolucion: string | null;
  formato: string | null;
  fecha_creacion: Date | null;
  local_updated_at: Date | null;
  platforms_updated_at: Date | null;
}

const FILE_PROJECTION = {
  file_name: 1, content_id: 1, platforms: 1, platforms_discarded: 1, platform_states: 1,
  content_status: 1, tipo_contenido: 1, scheduled_date: 1, duracion_segundos: 1, resolucion: 1,
  formato: 1, fecha_creacion: 1, local_updated_at: 1, platforms_updated_at: 1, createdAt: 1, updatedAt: 1,
} as const;

function toDto(f: any): CanonicalBackupFileDto {
  return {
    _id: f._id,
    createdAt: f.createdAt ?? f.fecha_creacion ?? f.updatedAt ?? new Date(),
    file_name: f.file_name,
    content_id: f.content_id ?? null,
    platforms: f.platforms ?? [],
    platforms_discarded: f.platforms_discarded ?? [],
    platform_states: f.platform_states ?? [],
    content_status: f.content_status ?? 'borrador',
    tipo_contenido: f.tipo_contenido ?? null,
    scheduled_date: f.scheduled_date ?? null,
    duracion_segundos: f.duracion_segundos ?? null,
    resolucion: f.resolucion ?? null,
    formato: f.formato ?? null,
    fecha_creacion: f.fecha_creacion ?? null,
    // Preferí el reloj dedicado del push (local_updated_at); si un archivo
    // nunca pasó por un push de backup (creado por Sincronizar/mobile/Nube),
    // cae a updatedAt de Mongo -- mismo criterio que ya usaba onlyInCentral
    // en el camino viejo.
    local_updated_at: f.local_updated_at ?? f.updatedAt ?? null,
    platforms_updated_at: f.platforms_updated_at ?? null,
  };
}

// GET /api/backup/files. Fuente única: `files`, sin status ELIMINADO_DISCO
// (un archivo borrado del disco no debe verse en el remoto -- mismo criterio
// que ya documenta pushFilesToCloud del lado del cliente). El camino viejo no
// filtraba esto de forma explícita para "onlyInCentral"; acá sí, a propósito
// -- otra diferencia intencional a validar en la comparación de la Entrega C.
export async function getCanonicalBackupFiles(
  userId: string,
  includeResolved: boolean,
): Promise<{ files: CanonicalBackupFileDto[]; video_folder: string | null }> {
  const [rows, user] = await Promise.all([
    FileModel.find({ userId, status: { $ne: 'ELIMINADO_DISCO' } }, FILE_PROJECTION).lean(),
    UserModel.findById(userId, { video_folder: 1 }).lean(),
  ]);

  const dtos = rows.map(toDto);
  const files = includeResolved
    ? dtos
    : dtos.filter(f => (f.platforms?.length ?? 0) + (f.platforms_discarded?.length ?? 0) < 3);

  return { files, video_folder: user?.video_folder ?? null };
}

// GET /api/backup/status. El camino viejo cuenta filas de BackupFileModel;
// acá "respaldado" pasa a significar "tiene backup_synced_at" -- la
// existencia de ese campo reemplaza la semántica de "hay una fila en
// backup_files" (docs/mongo-collections-consolidation-plan-2026-09-02.md §2).
export async function getCanonicalBackupStatus(
  userId: string,
): Promise<{ total: number; lastSync: Date | null }> {
  const [total, latest] = await Promise.all([
    FileModel.countDocuments({ userId, backup_synced_at: { $ne: null } }),
    FileModel.findOne({ userId, backup_synced_at: { $ne: null } }, { backup_synced_at: 1 })
      .sort({ backup_synced_at: -1 })
      .lean(),
  ]);
  return { total, lastSync: (latest as any)?.backup_synced_at ?? null };
}

// GET /api/backup/sync-status?contentIds=... — mismo criterio: "metadata
// respaldada" ahora es backup_synced_at != null sobre `files`, en vez de
// buscar una fila en `backup_files`.
export async function getCanonicalSyncStatusBackedUpSet(
  userId: string,
  contentIds: string[],
): Promise<Set<string>> {
  const rows = await FileModel.find(
    { userId, content_id: { $in: contentIds }, backup_synced_at: { $ne: null } },
    { content_id: 1 },
  ).lean();
  return new Set(rows.map(f => f.content_id).filter((id): id is string => !!id));
}
