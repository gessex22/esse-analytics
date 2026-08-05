import fs from 'fs';
import mongoose from 'mongoose';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { resolveRemoteLibraryFilePath, deleteRemoteLibraryFile } from './remote-library-storage.service';
import { protectedFor, isVideoEvictable } from './remote-library-retention.service';

// Tope de videos con BYTES reales en Nube por usuario (el documento/miniatura
// de catálogo no cuenta, igual que el almacenamiento dinámico -- ver
// remote-library-retention.service.ts). Pensado sobre todo para subidas
// manuales (celular, o "Subir a la nube" en Videos), que -- con el fix de
// safeToEvict de al lado -- ahora sí pueden quedar pegadas para siempre si
// nadie las controla.
export const MAX_REMOTE_LIBRARY_VIDEOS = 5;

interface CapacityCandidate {
  _id: mongoose.Types.ObjectId;
  fileName: string;
  storedFileName: string | null;
  safeToEvict?: boolean;
}

export async function countActiveRemoteLibraryVideos(userId: string, excludeContentId?: string): Promise<number> {
  const filter: Record<string, unknown> = { userId, storedFileName: { $ne: null } };
  if (excludeContentId) filter.contentId = { $ne: excludeContentId };
  return RemoteLibraryVideoModel.countDocuments(filter);
}

// Si hay lugar, no hace nada. Si no, intenta liberar el candidato más viejo
// (updatedAt asc) que NO esté protegido (no es el "próximo a publicar" de
// ninguna red, ver protectedFor) y sea evictable (mismo criterio que el
// barrido periódico: safeToEvict, o un hardlink real en disco). Si todo lo
// que ocupa los 5 lugares es manual/única copia, no hay nada para liberar --
// el caller decide qué hacer (rechazar la subida, o dejar que la precarga
// del calendario no se complete esta vez, best-effort como ya hace).
//
// excludeContentId: cuando la subida en curso es un re-intento/resume de un
// video que YA tiene una fila en Nube (mismo contentId), esa fila no cuenta
// como "uno de los 5 actuales" -- va a reemplazarse a sí misma, no sumar uno.
export async function ensureRemoteLibraryCapacity(userId: string, excludeContentId?: string): Promise<boolean> {
  const count = await countActiveRemoteLibraryVideos(userId, excludeContentId);
  if (count < MAX_REMOTE_LIBRARY_VIDEOS) return true;

  const candidates = await RemoteLibraryVideoModel.find({
    userId,
    storedFileName: { $ne: null },
    ...(excludeContentId ? { contentId: { $ne: excludeContentId } } : {}),
  }).select('fileName storedFileName safeToEvict').sort({ updatedAt: 1 }).lean<CapacityCandidate[]>();

  if (candidates.length === 0) return true; // el único ocupante es el propio excludeContentId

  const protectedIds = await protectedFor(userId);

  for (const v of candidates) {
    if (!v.storedFileName) continue;
    const isProtected = protectedIds.ids.has(String(v._id)) || protectedIds.names.has(v.fileName);
    if (isProtected) continue;

    const filePath = resolveRemoteLibraryFilePath(userId, v.storedFileName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue; // ya no está en disco -- no sirve como candidato a liberar
    }
    if (!isVideoEvictable(stat, v.safeToEvict)) continue;

    deleteRemoteLibraryFile(userId, v.storedFileName);
    await RemoteLibraryVideoModel.updateOne({ _id: v._id }, { $set: { storedFileName: null } });
    return true; // liberamos un lugar
  }

  return false; // los 5 lugares están ocupados por copias que no se pueden tocar
}
