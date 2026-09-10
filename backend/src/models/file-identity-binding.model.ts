import { Schema, model, Document } from 'mongoose';

// Vínculo determinístico entre el archivo LOCAL de un cliente y la identidad
// que la central le asignó.
//
// POR QUÉ EXISTE. Sin esto, resolver la identidad de un archivo importado en el
// teléfono solo podía hacerse por `file_name` -- y el nombre no es identidad.
// `ImportUseCase` de iOS marca `isDuplicate` pero CREA el archivo igual, y su
// dedup mira `(fileName, duracionSegundos, formato)`: dos videos DISTINTOS con
// el mismo nombre coexisten como dos `FileEntity`. Resolverlos por nombre les
// daría el mismo `content_id`, y a partir de ahí toda transición sobre uno
// afectaría al otro.
//
// La clave es `(userId, deviceId, clientFileId)`. `clientFileId` es el id
// estable del archivo EN ESE dispositivo, así que renombrarlo no cambia su
// identidad ni inaugura una nueva.
//
// Cuando el cliente ya conoce la identidad canónica -- porque trae `contentId`,
// o porque el archivo vino de Biblioteca remota -- el vínculo apunta a ESA en
// vez de crear otra. El nombre queda como metadata, nunca como criterio de
// unión: sin vínculo determinístico es más seguro crear dos identidades
// reconciliables después que fusionar dos videos distintos.
export interface IFileIdentityBinding extends Document {
  userId: string;
  deviceId: string;
  /** Id del archivo en el dispositivo. Estable ante renombres. */
  clientFileId: string;
  /** La identidad que la central asignó o reconoció. */
  contentId: string;
}

const FileIdentityBindingSchema = new Schema<IFileIdentityBinding>({
  userId:       { type: String, required: true },
  deviceId:     { type: String, required: true },
  clientFileId: { type: String, required: true },
  contentId:    { type: String, required: true },
}, { timestamps: true });

// Es lo que hace determinística la resolución: dos llamadas con el mismo
// vínculo no pueden crear dos identidades, sin importar si llegan en paralelo.
FileIdentityBindingSchema.index(
  { userId: 1, deviceId: 1, clientFileId: 1 }, { unique: true },
);

export const FileIdentityBindingModel = model<IFileIdentityBinding>(
  'FileIdentityBinding', FileIdentityBindingSchema, 'file_identity_bindings',
);
