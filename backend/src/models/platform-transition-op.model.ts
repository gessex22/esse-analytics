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
  /**
   * Qué platformIds abarca esta operación, congelados al reclamar.
   *
   * Es parte de su identidad, no algo a recalcular: al REANUDAR, volver a
   * leerlos de la base los devuelve vacíos (el intento anterior ya los soltó) y
   * la reanudación no terminaría de aplicar. Y al revés, recalcularlos tarde
   * puede incluir una publicación que entró después, que no le pertenece.
   */
  platformIds?: string[];
  /** Revisión resultante, una vez aplicada. */
  resultVersion?: number;
  /**
   * 'pending'    = registrada, sin terminar de aplicar.
   * 'completed'  = aplicada en todas las proyecciones.
   * 'superseded' = la superó otra operación. NO se reintenta: su baseVersion
   *                describe un estado que ya no existe, así que reprocesarla
   *                fallaría siempre igual. Lo que se repara es lo que alcanzó
   *                a escribir (ver transition-repair.service.ts).
   * 'failed'     = no se pudo aplicar ni reparar tras varios intentos.
   */
  status: 'pending' | 'completed' | 'superseded' | 'failed';
  completedAt?: Date;

  // ── Reproceso central (ver transition-repair.service.ts) ────────────────
  /**
   * Quién tiene la operación en la mano. Es un FENCING TOKEN, no una etiqueta:
   * cerrar o liberar exige presentarlo. `leaseUntil` por sí solo no impide que
   * un worker vencido termine encima del nuevo -- los dos se creen dueños.
   */
  leaseOwner?: string;
  leaseUntil?: Date;
  attempts?: number;
  nextAttemptAt?: Date;
  lastError?: string | null;
}

const PlatformTransitionOpSchema = new Schema<IPlatformTransitionOp>({
  userId:        { type: String, required: true },
  operationId:   { type: String, required: true },
  contentId:     { type: String, required: true },
  platform:      { type: String, required: true },
  action:        { type: String, required: true },
  baseVersion:   { type: Number },
  platformIds:   { type: [String], default: undefined },
  resultVersion: { type: Number },
  status:        { type: String, enum: ['pending', 'completed', 'superseded', 'failed'], default: 'pending' },
  completedAt:   { type: Date },
  leaseOwner:    { type: String },
  leaseUntil:    { type: Date },
  attempts:      { type: Number, default: 0 },
  nextAttemptAt: { type: Date },
  lastError:     { type: String, default: null },
}, { timestamps: true });

// La deduplicación se apoya en este índice: dos entregas de la misma operación
// no pueden crear dos registros, sin importar si llegan en paralelo.
PlatformTransitionOpSchema.index({ userId: 1, operationId: 1 }, { unique: true });
// El worker de reparación busca por acá: pendientes cuyo turno ya llegó.
PlatformTransitionOpSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });

export const PlatformTransitionOpModel = model<IPlatformTransitionOp>(
  'PlatformTransitionOp', PlatformTransitionOpSchema, 'platform_transition_ops',
);
