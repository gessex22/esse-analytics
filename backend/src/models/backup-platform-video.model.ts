import { Schema, model, Document } from 'mongoose';

// Espejo central de la tabla local platform_videos: el vínculo real archivo↔publicación
// (qué platform_id/URL específico corresponde a qué video). Sin esto, el wipe de logout
// (que borra platform_videos en SQLite) dejaba solo el flag "publicado en X" en BackupFile,
// pero perdía para siempre el ID/URL/fecha de la publicación real.
export interface IBackupPlatformVideo extends Document {
  userId: string;
  platform: string;
  platform_id: string;
  platform_url?: string;
  device_id?: string;
  source?: string;
  published_at?: Date;
  file_name?: string;      // resuelto desde linked_file_id (los IDs locales no son portables)
  content_id?: string;     // igual que file_name, pero estable ante renombres (ver BackupFile.content_id)
  match_status: string;
  title?: string;
  description?: string;
  local_updated_at: Date;

  // ── Tombstone de desvinculación ───────────────────────────────────────────
  // Esta colección es de donde CADA escritorio reconstruye sus links locales al
  // hacer pull. Si al desvincular se BORRABA la fila, un segundo dispositivo que
  // ya tenía el link no se enteraba nunca: `pullPlatformVideosFromCloud` no
  // elimina jamás filas locales ausentes de la respuesta, así que se lo quedaba
  // para siempre. La fila se conserva marcada como `unlinked` para que ese pull
  // tenga algo que procesar.
  //
  // `content_id` se conserva a propósito en el tombstone: es lo que le dice a la
  // otra PC QUÉ asociación retirar (el platform_id solo no alcanza, hay que
  // saber de qué archivo se despega).
  link_state?: 'linked' | 'unlinked';
  // Reloj propio del vínculo, separado de `local_updated_at` (que se mueve con
  // cualquier campo). Es contra este timestamp que se decide si el push de una
  // PC atrasada puede pisar un tombstone más nuevo.
  link_updated_at?: Date;
  /**
   * Revisión PROPIA del vínculo (userId, platform, platform_id). La emite el
   * servidor con `$inc`, en la misma escritura que cambia el vínculo: es
   * monotónica sin importar de qué archivo venga el cambio, y es lo que comparan
   * los dispositivos para ordenar dos estados del mismo vínculo.
   *
   * Antes era la revisión de ESTADO del archivo que lo escribió, y eso no se
   * puede comparar cuando el vínculo se reasigna: soltarlo de A en su revisión 4
   * y publicarlo en B -- que empieza de cero -- dejaba el 1 de B por debajo del
   * 4 de A, y la reasignación se rechazaba en la central y en los teléfonos.
   */
  link_version?: number;
  /**
   * Revisión de ESTADO del archivo (`content_id`) que escribió este vínculo.
   * Solo se compara contra escrituras del MISMO contenido: ahí sí ordena, y es lo
   * que impide que una transición vieja pise una publicación posterior sobre ese
   * archivo. Un push de PC la deja en 0: no trae revisión de archivo.
   */
  link_file_rev?: number;
  // Idempotencia: repetir la misma operación no cambia el resultado, y permite
  // reanudar una que quedó a medias sin duplicar efectos.
  operation_id?: string;
}

const BackupPlatformVideoSchema = new Schema<IBackupPlatformVideo>({
  userId:           { type: String, required: true },
  platform:         { type: String, required: true },
  platform_id:      { type: String, required: true },
  platform_url:     { type: String },
  device_id:        { type: String },
  source:           { type: String },
  published_at:     { type: Date },
  file_name:        { type: String },
  content_id:       { type: String },
  match_status:     { type: String, default: 'sin_match' },
  title:            { type: String },
  description:      { type: String },
  local_updated_at: { type: Date, required: true },
  link_state:       { type: String, enum: ['linked', 'unlinked'], default: 'linked' },
  link_updated_at:  { type: Date },
  link_version:     { type: Number },
  link_file_rev:    { type: Number },
  operation_id:     { type: String },
}, { timestamps: true });

BackupPlatformVideoSchema.index({ userId: 1, platform: 1, platform_id: 1 }, { unique: true });

/**
 * Guard de una escritura sobre una fila del MISMO contenido: pasa si la
 * revisión de archivo que la selló no es posterior a la de quien escribe.
 *
 * Una fila de antes de `link_file_rev` todavía tiene en `link_version` la
 * revisión de archivo de entonces: mientras nadie la vuelva a escribir, se
 * compara esa.
 */
export function noEsMasNuevaEnEsteArchivo(revDelArchivo: number) {
  return {
    $or: [
      { link_file_rev: { $lte: revDelArchivo } },
      {
        link_file_rev: { $exists: false },
        $or: [{ link_version: { $exists: false } }, { link_version: { $lte: revDelArchivo } }],
      },
    ],
  };
}

export const BackupPlatformVideoModel = model<IBackupPlatformVideo>(
  'BackupPlatformVideo', BackupPlatformVideoSchema, 'backup_platform_videos',
);
