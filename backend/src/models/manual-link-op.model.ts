import { Document, Schema, model } from 'mongoose';

/**
 * Operación padre de un vínculo manual.
 *
 * Mover un link de B a A son dos transiciones causales. Sin este registro, una
 * caída después de retirar B pierde para siempre el dato de cuál era el
 * destino. El worker puede reanudar usando esta foto congelada.
 */
export interface IManualLinkOp extends Document {
  userId: string;
  operationId: string;
  platform: string;
  platformId: string;
  platformUrl?: string | null;
  title?: string | null;
  publishedAt?: Date | null;
  matchStatus: string;
  targetFileId: string;
  targetContentId: string;
  targetFileName: string;
  sourceFileId?: string | null;
  sourceContentId?: string | null;
  sourceBaseVersion?: number | null;
  status: 'pending' | 'completed' | 'superseded' | 'failed';
  resultVersion?: number;
  completedAt?: Date;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
  /**
   * Fencing token durable: sube en CADA adquisición del lease (reserva inicial,
   * re-adquisición por request, toma por el worker). No es diagnóstico -- es lo
   * que distingue "esta ejecución sigue siendo la dueña" de "otra ya la superó",
   * incluso cuando `leaseOwner` es el mismo valor externo (caller que reusa un
   * `existingLeaseOwner`) o cuando la operación ya se cerró y no queda claim que
   * comparar. Ver el comentario de `procesar` en manual-platform-link.service.ts.
   */
  fence: number;
  attempts: number;
  nextAttemptAt?: Date | null;
  lastError?: string | null;
}

const ManualLinkOpSchema = new Schema<IManualLinkOp>({
  userId: { type: String, required: true },
  operationId: { type: String, required: true },
  platform: { type: String, required: true },
  platformId: { type: String, required: true },
  platformUrl: { type: String, default: null },
  title: { type: String, default: null },
  publishedAt: { type: Date, default: null },
  matchStatus: { type: String, default: 'manual' },
  targetFileId: { type: String, required: true },
  targetContentId: { type: String, required: true },
  targetFileName: { type: String, required: true },
  sourceFileId: { type: String, default: null },
  sourceContentId: { type: String, default: null },
  sourceBaseVersion: { type: Number, default: null },
  status: { type: String, enum: ['pending', 'completed', 'superseded', 'failed'], default: 'pending' },
  resultVersion: { type: Number },
  completedAt: { type: Date },
  leaseOwner: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  fence: { type: Number, default: 0 },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: null },
  lastError: { type: String, default: null },
}, { timestamps: true });

ManualLinkOpSchema.index({ userId: 1, operationId: 1 }, { unique: true });
ManualLinkOpSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });

export const ManualLinkOpModel = model<IManualLinkOp>(
  'ManualLinkOp', ManualLinkOpSchema, 'manual_link_ops',
);
