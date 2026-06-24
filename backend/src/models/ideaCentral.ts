import { Schema, model, Document } from 'mongoose';

interface IVideoVinculado {
  file_id: { $oid: string } | string;
  file_name: string;
  file_path: string;
  fecha_creacion: Date;
  duracion_segundos: number;
  formato: string;
  resolucion: string;
  similitud_guion: number;
  rol: 'POR_DEFECTO' | 'RELACIONADO'; // 'POR_DEFECTO' = Principal, 'RELACIONADO' = Previa
}

export type IdeaStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado';

export interface IIdeaCentral extends Document {
  idea_nucleo: string;
  resumen_visual: string;
  video_principal_id: string | null;
  videos_vinculados: IVideoVinculado[];
  total_renders: number;
  ultima_actualizacion: Date;
  status: IdeaStatus;
}

const VideoVinculadoSchema = new Schema<IVideoVinculado>({
  file_id: { type: Schema.Types.Mixed, required: true },
  file_name: { type: String, required: true },
  file_path: { type: String },
  fecha_creacion: { type: Date },
  duracion_segundos: { type: Number },
  formato: { type: String },
  resolucion: { type: String },
  similitud_guion: { type: Number },
  rol: { type: String, enum: ['POR_DEFECTO', 'RELACIONADO'], default: 'RELACIONADO' }
});

const IdeaCentralSchema = new Schema<IIdeaCentral>({
  idea_nucleo: { type: String, required: true },
  resumen_visual: { type: String },
  video_principal_id: { type: String, default: null },
  videos_vinculados: [VideoVinculadoSchema],
  total_renders: { type: Number, default: 0 },
  ultima_actualizacion: { type: Date, default: Date.now },
  status: { type: String, enum: ['publicado', 'borrador', 'procesando', 'descartado'], default: 'borrador' }
}, { collection: 'ideas_centrales' }); // Se conecta exactamente a tu tabla

export const IdeaCentral = model<IIdeaCentral>('IdeaCentral', IdeaCentralSchema);