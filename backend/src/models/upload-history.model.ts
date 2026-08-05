import { Schema, model, Document } from 'mongoose';

// Registro real de eventos de publicación: un documento por cada subida CONFIRMADA,
// escrito en el momento exacto en que pasa (desde el upload controller de cada
// plataforma), no reconstruido después vía push/pull. A diferencia de
// backup_platform_videos (un espejo que solo tiene lo que el catálogo local haya
// llegado a empujar entero, y se vacía en cada wipe de logout), este es un log de
// eventos append-only con el dispositivo de origen -- sobrevive cualquier wipe local
// porque nunca dependió de él para existir.
export interface IUploadHistory extends Document {
  userId: string;
  source?: string;
  deviceId: string;      // install_id de la instalación que hizo la publicación
  platform: string;
  platformId: string;
  platformUrl?: string;
  fileName?: string;
  contentId?: string;
  title?: string;
  publishedAt: Date;
  // UUID del LOTE de publicación que generó este evento (ver PublishBatchState
  // en iOS/Android, Fase 2) -- opcional (deviceId ya identifica la instalación,
  // esto además agrupa "estos N eventos salieron de la misma tanda"). No es
  // parte de la clave de idempotencia: esa sigue siendo platform+platformId
  // (el video/plataforma real), no la corrida que lo produjo -- un reintento
  // de la MISMA plataforma trae un operationId distinto pero debe seguir
  // actualizando el mismo registro, no duplicarlo.
  operationId?: string;
}

const UploadHistorySchema = new Schema<IUploadHistory>({
  userId:      { type: String, required: true },
  source:      { type: String },
  deviceId:    { type: String, required: true },
  platform:    { type: String, required: true },
  platformId:  { type: String, required: true },
  platformUrl: { type: String },
  fileName:    { type: String },
  contentId:   { type: String },
  title:       { type: String },
  publishedAt: { type: Date, required: true },
  operationId: { type: String },
}, { timestamps: true });

// Único por usuario+plataforma+id -- una republicación del mismo video (mismo
// platformId) actualiza su registro en vez de duplicarlo; cada video/plataforma
// real distinto sigue generando su propia fila.
UploadHistorySchema.index({ userId: 1, platform: 1, platformId: 1 }, { unique: true });
UploadHistorySchema.index({ userId: 1, publishedAt: -1 });

export const UploadHistoryModel = model<IUploadHistory>(
  'UploadHistory', UploadHistorySchema, 'upload_history',
);
