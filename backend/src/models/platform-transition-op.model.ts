import { Schema, model, Document } from 'mongoose';

// Registro persistente de transiciones de plataforma, para deduplicación real.
//
// POR QUÉ EXISTE. `operationId` sin nada detrás no deduplica: cada reintento
// vuelve a aplicar los efectos. Y peor -- si una operación falla a mitad de
// camino (5 proyecciones secuenciales, sin transacción), no hay forma de saber
// que quedó incompleta ni de retomarla. Esta colección es la que permite las
// dos cosas:
//
//   - `completed`: repetir devuelve el resultado guardado sin volver a aplicar.
//   - `pending`:   la operación quedó a medias -> se REANUDA. Las 5 escrituras
//                  son idempotentes ("poner en este valor"), así que repetirlas
//                  converge sin necesidad de rollback.
//
// Es durable a propósito: sobrevive a un reinicio de la central, que es
// justamente cuando una operación puede quedar partida por la mitad.
export interface IPlatformTransitionOp extends Document {
  userId: string;
  operationId: string;
  contentId: string;
  platform: string;
  action: string;
  /** Revisión de esa plataforma sobre la que el cliente basó su operación. */
  baseVersion?: number;
  /** Revisión resultante, una vez aplicada. */
  resultVersion?: number;
  status: 'pending' | 'completed';
  completedAt?: Date;
}

const PlatformTransitionOpSchema = new Schema<IPlatformTransitionOp>({
  userId:        { type: String, required: true },
  operationId:   { type: String, required: true },
  contentId:     { type: String, required: true },
  platform:      { type: String, required: true },
  action:        { type: String, required: true },
  baseVersion:   { type: Number },
  resultVersion: { type: Number },
  status:        { type: String, enum: ['pending', 'completed'], default: 'pending' },
  completedAt:   { type: Date },
}, { timestamps: true });

// La deduplicación se apoya en este índice: dos entregas de la misma operación
// no pueden crear dos registros, sin importar si llegan en paralelo.
PlatformTransitionOpSchema.index({ userId: 1, operationId: 1 }, { unique: true });

export const PlatformTransitionOpModel = model<IPlatformTransitionOp>(
  'PlatformTransitionOp', PlatformTransitionOpSchema, 'platform_transition_ops',
);
