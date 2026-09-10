import { FileIdentityBindingModel } from '../models/file-identity-binding.model';

/**
 * Índices sin los cuales una corrección de correctitud deja de funcionar.
 *
 * No es cualquier índice: son los que un guard NECESITA para hacer su trabajo.
 * El vínculo de identidad es el caso -- toda su garantía ("dos resoluciones
 * concurrentes no pueden reservar dos identidades") se apoya en que
 * `(userId, deviceId, clientFileId)` sea único. Sin ese índice el `$setOnInsert`
 * no choca con nada y las dos escrituras entran.
 */
const CRITICOS = [
  { nombre: 'file_identity_bindings (userId, deviceId, clientFileId)', modelo: FileIdentityBindingModel },
];

/**
 * Construye los índices críticos y falla si no puede.
 *
 * Se llama ANTES de `app.listen()`, a propósito. Mongoose construye los índices
 * de forma asíncrona al inicializar el modelo, así que un server que empieza a
 * escuchar apenas conecta atiende requests durante una ventana en la que el
 * índice todavía no existe -- y en esa ventana la reserva de identidad puede
 * duplicarse, que es exactamente lo que el índice viene a impedir.
 *
 * Y falla ruidosamente en vez de seguir: un arranque que no puede garantizar la
 * unicidad es peor que un arranque que no ocurre. Con el server caído se ve; con
 * identidades duplicadas, no.
 */
export async function asegurarIndicesCriticos(): Promise<void> {
  for (const { nombre, modelo } of CRITICOS) {
    try {
      await modelo.createIndexes();
    } catch (err: any) {
      throw new Error(
        `No se pudo crear el índice crítico ${nombre}: ${err?.message ?? err}. ` +
        `Sin él, dos resoluciones concurrentes pueden reservar identidades distintas ` +
        `para el mismo archivo. El arranque se aborta a propósito.`,
      );
    }
  }
}
