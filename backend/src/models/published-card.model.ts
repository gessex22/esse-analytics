import { Schema, model, Document } from 'mongoose';

// Espejo de las tarjetas de "último video publicado" que la app construye en local.
// La app las sube (mirror) para que la web/remoto pueda mostrarlas sin acceso al SQLite local.
// Solo metadatos + datos públicos de la plataforma (miniatura, stats); nunca el archivo físico.
export interface IPublishedCard extends Document {
  userId: string;
  platform: 'youtube' | 'instagram' | 'tiktok';
  fileName?: string | null;
  platformId?: string | null;
  platformUrl?: string | null;
  publishedAt?: Date | null;
  title?: string | null;
  status?: string | null;
  stats?: Record<string, any>;
  updatedAt: Date;
}

const publishedCardSchema = new Schema<IPublishedCard>({
  userId:      { type: String, required: true },
  platform:    { type: String, required: true, enum: ['youtube', 'instagram', 'tiktok'] },
  fileName:    { type: String, default: null },
  platformId:  { type: String, default: null },
  platformUrl: { type: String, default: null },
  publishedAt: { type: Date,   default: null },
  title:       { type: String, default: null },
  status:      { type: String, default: null },
  stats:       { type: Schema.Types.Mixed, default: undefined },
}, { timestamps: { createdAt: false, updatedAt: true } });

// Una tarjeta por usuario + plataforma (la última publicada).
publishedCardSchema.index({ userId: 1, platform: 1 }, { unique: true });

export const PublishedCardModel = model<IPublishedCard>('PublishedCard', publishedCardSchema, 'published_cards');
