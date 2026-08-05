import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import { FileModel } from '../models/file.model';
import { RemoteLibraryVideoModel } from '../models/remote-library-video.model';
import { resolveRemoteLibraryFilePath, deleteRemoteLibraryFile } from './remote-library-storage.service';

// Almacenamiento dinámico: en Biblioteca remota solo se conservan los BYTES del
// video para el "próximo a publicar" de cada plataforma (hasta 3 -- uno por
// youtube/instagram/tiktok, vía platform_config.nextVideoId, lo mismo que ya
// usa getCalendarConfig). El resto se libera -- documento y miniatura quedan
// intactos (Estadísticas/Historial no dependen de los bytes del video), solo
// se borra el archivo pesado.
const PLATFORMS = ['youtube', 'instagram', 'tiktok'] as const;

// nextVideoId en platform_config es un id de FileModel O un file_name suelto
// (mismo fallback que getCalendarConfig en sync.controller.ts) -- acá solo
// interesa a qué file_name resuelve, para cruzarlo contra Biblioteca remota.
async function resolveNextFileName(userId: string, nextVideoId: string): Promise<string | null> {
  try {
    const byId = await FileModel.findOne({ _id: new mongoose.Types.ObjectId(nextVideoId), userId })
      .select('file_name').lean();
    if (byId) return byId.file_name;
  } catch { /* nextVideoId no es un ObjectId válido -- probar por nombre */ }
  const byName = await FileModel.findOne({ file_name: nextVideoId, userId }).select('file_name').lean();
  return byName?.file_name ?? null;
}

export interface ProtectedFor {
  ids: Set<string>;   // nextRemoteLibraryVideoId directo -- fuente de verdad, sin ambigüedad
  names: Set<string>; // fallback por fileName para configs viejas sin el id explícito todavía
}

// Exportada -- remote-library-quota.service.ts la reusa para decidir qué NO
// tocar al liberar lugar on-demand (mismo criterio que el barrido periódico,
// nunca se libera lo que hoy es "el próximo a publicar" de alguna red).
export async function protectedFor(userId: string): Promise<ProtectedFor> {
  const db = mongoose.connection.db!;
  const configs = await db.collection('platform_config')
    .find({ userId, platform: { $in: PLATFORMS as readonly string[] as string[] } })
    .toArray();

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const cfg of configs) {
    if (cfg.nextRemoteLibraryVideoId) {
      ids.add(String(cfg.nextRemoteLibraryVideoId));
      continue; // ya viene resuelto por el cliente -- no hace falta el fallback por nombre
    }
    if (!cfg.nextVideoId) continue;
    const name = await resolveNextFileName(userId, String(cfg.nextVideoId));
    if (name) names.add(name);
  }
  return { ids, names };
}

export interface RetentionSweepResult {
  usersScanned: number;
  protectedCount: number;
  evicted: number;
  keptSoleCopy: number;
  hardened: number;
}

const EMPTY_RESULT: RetentionSweepResult = { usersScanned: 0, protectedCount: 0, evicted: 0, keptSoleCopy: 0, hardened: 0 };

// Un protegido (el "próximo a publicar") todavía puede estar hardlinkeado al
// archivo local (nlink > 1) -- eso alcanza mientras solo importaba no gastar
// espacio de más con 300 videos, pero ahora que solo quedan ~3 protegidos a la
// vez, vale la pena que sean copias independientes de verdad: si el archivo
// local se mueve/borra/renombra (limpieza normal de disco del usuario), el
// hardlink no se entera y la Biblioteca remota queda con datos huérfanos o
// ata a un nombre que ya no existe. Rompe el hardlink escribiendo una copia
// real y actualiza el doc para apuntar a esa copia -- el archivo local no se
// toca en ningún momento.
async function hardenIfHardlinked(userId: string, storedFileName: string, docId: mongoose.Types.ObjectId): Promise<boolean> {
  const oldPath = resolveRemoteLibraryFilePath(userId, storedFileName);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(oldPath);
  } catch {
    return false; // no está en disco -- nada que endurecer
  }
  if (stat.nlink <= 1) return false; // ya es una copia independiente

  const newStoredFileName = `${randomUUID()}${path.extname(storedFileName) || '.mp4'}`;
  const newPath = resolveRemoteLibraryFilePath(userId, newStoredFileName);

  fs.copyFileSync(oldPath, newPath);
  // safeToEvict: true -- esta copia se hizo A PARTIR de un archivo local que
  // existía en ese momento (el hardlink lo prueba). Cuando este video deje de
  // ser "el próximo", el sweep puede liberarlo aunque ya tenga nlink === 1 --
  // sin este flag quedaría pegado para siempre (ver interpretación de nlink
  // más abajo en el loop principal).
  await RemoteLibraryVideoModel.updateOne({ _id: docId }, { $set: { storedFileName: newStoredFileName, safeToEvict: true } });
  fs.unlinkSync(oldPath); // libera el hardlink viejo -- el local queda con su propio link intacto
  return true;
}

// Un video es evictable si hay motivo para creer que no es la única copia:
// otro hardlink real en disco (nlink > 1, ej. el archivo local del que se hizo
// hardlink en la migración) o el flag explícito safeToEvict (copia deliberada
// hecha a partir de un archivo local conocido). Mismo criterio que usa el
// barrido de abajo -- exportada para que remote-library-quota.service.ts la
// use al liberar lugar on-demand.
export function isVideoEvictable(stat: fs.Stats, safeToEvict: boolean | undefined): boolean {
  return stat.nlink > 1 || !!safeToEvict;
}

let sweepInProgress = false;

// Corre periódico (no al instante en cada publish/cambio de calendario, ver
// server.ts) -- barre TODOS los usuarios con algo en Biblioteca remota.
export async function runRemoteLibraryRetentionSweep(): Promise<RetentionSweepResult> {
  if (sweepInProgress) return EMPTY_RESULT;
  sweepInProgress = true;
  try {
    const userIds = (await RemoteLibraryVideoModel.distinct('userId')) as string[];
    let protectedCount = 0, evicted = 0, keptSoleCopy = 0, hardened = 0;

    for (const userId of userIds) {
      const protectedIds = await protectedFor(userId);

      const videos = await RemoteLibraryVideoModel.find({ userId }).select('fileName storedFileName safeToEvict').lean();
      // Mismo criterio conservador que en getGroupStats: un fileName repetido
      // dentro de la misma cuenta es ambiguo (no se sabe cuál es cuál) --
      // se protege de más antes que arriesgar borrar el video equivocado.
      // Ya no aplica para lo protegido por id directo (protectedIds.ids), solo
      // como fallback para configs viejas que todavía resuelven por nombre.
      const nameCounts = new Map<string, number>();
      for (const v of videos) nameCounts.set(v.fileName, (nameCounts.get(v.fileName) ?? 0) + 1);

      for (const v of videos) {
        if (!v.storedFileName) continue;
        const isProtected = protectedIds.ids.has(String(v._id))
          || protectedIds.names.has(v.fileName)
          || (nameCounts.get(v.fileName) ?? 0) > 1;
        if (isProtected) {
          protectedCount++;
          if (await hardenIfHardlinked(userId, v.storedFileName, v._id)) hardened++;
          continue;
        }

        const filePath = resolveRemoteLibraryFilePath(userId, v.storedFileName);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue; // ya no está en disco -- nada que liberar
        }

        // nlink > 1: todavía hay OTRO link a los mismos bytes (ej. el archivo
        // local del que se hizo hardlink en la migración, ver
        // migrate-local-to-nube-copy.js) -- borrar esta entrada NO borra el
        // video real, solo la copia redundante en Biblioteca remota.
        // nlink === 1 pero safeToEvict: esta copia se hizo a partir de un
        // archivo local conocido (endurecido, o subida de ensureNextVideoInRemoteLibrary)
        // -- tampoco es la única copia real, solo dejó de tener el hardlink.
        // nlink === 1 sin safeToEvict: acá sí podría ser la ÚNICA copia (ej.
        // subida directa por TUS desde el celular, sin archivo local en esta
        // PC) -- nunca se borra, sería una pérdida real y permanente.
        if (isVideoEvictable(stat, v.safeToEvict)) {
          deleteRemoteLibraryFile(userId, v.storedFileName);
          // storedFileName a null -- así el listado (GET /api/remote-library/videos)
          // puede filtrar limpio por "todavía tiene bytes" sin tener que golpear
          // el filesystem por cada fila. El documento y la miniatura no se tocan.
          await RemoteLibraryVideoModel.updateOne({ _id: v._id }, { $set: { storedFileName: null } });
          evicted++;
        } else {
          keptSoleCopy++;
        }
      }
    }

    return { usersScanned: userIds.length, protectedCount, evicted, keptSoleCopy, hardened };
  } finally {
    sweepInProgress = false;
  }
}
