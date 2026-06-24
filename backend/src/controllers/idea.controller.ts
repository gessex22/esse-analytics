import { Request, Response } from 'express';
import { IdeaCentral, IdeaStatus } from '../models/ideacentral';
import mongoose from 'mongoose';
import * as fs from 'fs';

import path from 'path'

// ➔ GET: Obtener las ideas procesadas para mapear el diseño del Figma
export const getTallerIdeas = async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Traemos los documentos directo de la BD (excluye descartados por defecto)
    const ideas = await IdeaCentral.find({
      $or: [{ status: { $exists: false } }, { status: { $ne: 'descartado' } }]
    }).sort({ ultima_actualizacion: -1 }).lean();

    const processedIdeas = ideas.map((idea) => {
      const videos = idea.videos_vinculados || [];

      // ➔ REGLA DE ORO NUEVA: Buscamos cuál es el video principal usando el nuevo campo directo de la BD
      const idPrincipalBD = idea.video_principal_id;
      
      let videoPrincipal = null;
      if (idPrincipalBD) {
        videoPrincipal = videos.find(v => String(v.file_id) === String(idPrincipalBD)) || null;
      }
      
      // Fallback si no hay video_principal_id guardado aún en la BD
      if (!videoPrincipal) {
        videoPrincipal = videos.find(v => v.rol === 'POR_DEFECTO') || videos[0] || null;
      }

      // Las versiones previas (alternativas) serán todas las que NO sean el principal actual
      const versionesPrevias = videoPrincipal 
        ? videos.filter(v => String(v.file_id) !== String(videoPrincipal.file_id))
        : [];

      // Generar título limpio para el nivel 1
      const rawTitle = idea.resumen_visual || idea.idea_nucleo || "Idea sin título";
      const title = rawTitle.length > 60 ? rawTitle.substring(0, 60) + "..." : rawTitle;

      return {
        _id: idea._id,
        title: title,
        status: (idea as any).status || 'borrador',
        idea_nucleo: idea.idea_nucleo,
        // Mandamos las versiones tal cual las espera recibir tu frontend estructurado actual
        videoPrincipal: videoPrincipal ? {
          id: String(videoPrincipal.file_id),
          name: videoPrincipal.file_name,
          duration: `${Math.floor(videoPrincipal.duracion_segundos / 60)}:${String(Math.floor(videoPrincipal.duracion_segundos % 60)).padStart(2, '0')}`,
          format: videoPrincipal.formato,
          fecha: idea.ultima_actualizacion
        } : null,
        versionesPrevias: versionesPrevias.map(v => ({
          id: String(v.file_id),
          name: v.file_name,
          duration: `${Math.floor(v.duracion_segundos / 60)}:${String(Math.floor(v.duracion_segundos % 60)).padStart(2, '0')}`,
          format: v.formato,
          fecha: idea.ultima_actualizacion
        })),
        publicados: "N/A"
      };
    });

    res.status(200).json(processedIdeas);
  } catch (error) {
    console.error("Error en el Taller al traer ideas_centrales:", error);
    res.status(500).json({ message: "Error interno en el servidor." });
  }
};

// ➔ PATCH: Cuando cambies el video principal en el Taller (Intercambiar Roles)
export const setMainVersion = async (req: Request, res: Response): Promise<void> => {
  try {
    const { ideaId } = req.params;     // URL: /api/ideas-centrales/:ideaId/set-main
    const { versionId } = req.body;    // JSON: { "versionId": "id_del_video" }

    if (!ideaId || !versionId) {
      res.status(400).json({ message: "Faltan parámetros requeridos (ideaId o versionId)." });
      return;
    }

    // ➔ ACTUALIZACIÓN DIRECTA: Guardamos el ID de la versión como el nuevo principal de la idea
    const updatedIdea = await IdeaCentral.findByIdAndUpdate(
      ideaId,
      { 
        $set: { 
          video_principal_id: versionId,
          ultima_actualizacion: new Date() // Actualizamos la estampa de tiempo
        } 
      },
      { new: true } // Nos devuelve el documento ya modificado
    );

    if (!updatedIdea) {
      res.status(404).json({ message: "No se encontró la idea central especificada." });
      return;
    }

    res.status(200).json({ message: "Versión principal actualizada con éxito.", idea: updatedIdea });
  } catch (error: any) {
    console.error("Error al actualizar la versión principal:", error);
    res.status(500).json({ message: "Error interno al procesar la solicitud.", error: error.message });
  }
};


// ➔ DELETE: Eliminar video individual, su .mp4 en disco y su transcripción .txt asociada
export const deleteVideoIndividual = async (req: Request, res: Response): Promise<void> => {
  const { ideaId, videoId } = req.params;

  try {
    // 1. Buscar la idea raíz por su ID
    const idea = await IdeaCentral.findById(ideaId);
    if (!idea) {
      res.status(404).json({ message: "Idea central no encontrada." });
      return;
    }

    // 2. Buscar el video dentro del array 'videos_vinculados' de la idea
    const videoIndex = idea.videos_vinculados.findIndex(
      (v) => String(v.file_id) === String(videoId)
    );

    if (videoIndex === -1) {
      res.status(404).json({ message: "Archivo de video no encontrado en esta idea." });
      return;
    }

    const videoTarget = idea.videos_vinculados[videoIndex];

    // Convertimos el videoId a un ObjectId válido de MongoDB para buscar en las otras colecciones
    const fileObjectId = new mongoose.Types.ObjectId(videoId);

    // Accedemos directamente a la base de datos nativa de MongoDB a través de Mongoose
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error("No se pudo establecer conexión con la base de datos.");
    }

    // ========================================================
    // 3. ¡BORRAR LA TRANSCRIPCIÓN DE LA COLECCIÓN EN MONGO!
    // ========================================================
    // Accedemos a la colección 'transcripts' de forma nativa usando el Schema que me diste
    const transcriptCollection = db.collection('transcripts'); // <- Asegúrate de que tu colección se llame así en Compass
    const transcriptDeleted = await transcriptCollection.deleteOne({ file_id: fileObjectId });
    console.log(`-> Transcripción nativa eliminada: ${transcriptDeleted.deletedCount} documento(s)`);


    // ========================================================
    // 4. ¡BORRAR EL ARCHIVO FÍSICO Y SU REGISTRO DE LA COLECCIÓN FILES!
    // ========================================================
    const filesCollection = db.collection('files'); // <- Asegúrate de que tu colección de archivos se llame así
    
    // Primero, intentamos recuperar la ruta del archivo físico desde el documento de la colección 'files'
    const archivoEnBD = await filesCollection.findOne({ _id: fileObjectId });
    
    // Usamos la ruta que tenga la colección 'files', y si no, la que venía guardada en la idea
    const pathABorrar = archivoEnBD?.file_path || videoTarget.file_path;

    // Borramos el archivo físico (.mp4) del almacenamiento de tu computadora
    if (pathABorrar && fs.existsSync(pathABorrar)) {
      fs.unlinkSync(pathABorrar);
      console.log(`-> ARCHIVO FÍSICO ELIMINADO TOTALMENTE DEL DISCO: ${pathABorrar}`);
    } else {
      console.log(`-> Alerta: No se encontró el archivo físico en la ruta: ${pathABorrar}`);
    }

    // Eliminamos el documento de la colección de archivos de la base de datos
    const fileDeleted = await filesCollection.deleteOne({ _id: fileObjectId });
    console.log(`-> Documento de archivo eliminado de la colección files: ${fileDeleted.deletedCount}`);


    // ========================================================
    // 5. SACAR EL REGISTRO DE LA IDEA CENTRAL Y REASIGNAR PRINCIPAL
    // ========================================================
    idea.videos_vinculados.splice(videoIndex, 1);

    // B. Saneamos los roles inválidos ('SUGERENCIA_BORRAR' -> 'RELACIONADO')
    idea.videos_vinculados = idea.videos_vinculados.map((v) => {
      if (v.rol && String(v.rol) === 'SUGERENCIA_BORRAR') {
        v.rol = 'RELACIONADO'; 
      }
      return v;
    });

    // C. CONTROL DE SEGURIDAD INTERNO: ¿Qué pasa si no queda ningún POR_DEFECTO?
    if (idea.videos_vinculados.length > 0) {
      // Verificamos si actualmente hay algún video con rol 'POR_DEFECTO'
      const tienePrincipal = idea.videos_vinculados.some(v => v.rol === 'POR_DEFECTO');

      // Si no hay ninguno establecido como 'POR_DEFECTO' (o borramos el único que había)
      if (!tienePrincipal) {
        // Promovemos el primer video disponible de la lista a principal
        idea.videos_vinculados[0].rol = 'POR_DEFECTO';
        idea.video_principal_id = String(idea.videos_vinculados[0].file_id);
        console.log(`-> Seguridad: Se promovió automáticamente el video [${idea.videos_vinculados[0].file_name}] a POR_DEFECTO.`);
      } else {
        // Si sí hay un POR_DEFECTO pero el video_principal_id quedó desincronizado
        const principalActual = idea.videos_vinculados.find(v => v.rol === 'POR_DEFECTO');
        if (principalActual) {
          idea.video_principal_id = String(principalActual.file_id);
        }
      }
    } else {
      // Si la idea se quedó totalmente vacía de videos
      idea.video_principal_id = null;
    }

    // D. Guardamos los cambios con total seguridad y cumplimiento del Schema
    await idea.save();

    res.status(200).json({
      success: true,
      message: "Contenido eliminado, roles saneados y video principal recalculado con éxito."
    });

  } catch (error: any) {
    console.error("Error crítico en el backend al eliminar el contenido de forma nativa:", error);
    res.status(500).json({ message: "Error interno del servidor.", error: error.message });
  }
};

// ➔ PATCH: Actualizar el estado de una idea central (publicado, borrador, procesando, descartado)
export const updateIdeaStatus = async (req: Request, res: Response): Promise<void> => {
  const { ideaId } = req.params;
  const { status } = req.body as { status: IdeaStatus };

  const validStatuses: IdeaStatus[] = ['publicado', 'borrador', 'procesando', 'descartado'];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ message: 'Estado inválido.' });
    return;
  }

  try {
    const updated = await IdeaCentral.findByIdAndUpdate(
      ideaId,
      { status, ultima_actualizacion: new Date() },
      { new: true }
    );

    if (!updated) {
      res.status(404).json({ message: 'Idea no encontrada.' });
      return;
    }

    res.status(200).json({ message: 'Estado actualizado.', status: updated.status });
  } catch (error: any) {
    res.status(500).json({ message: 'Error interno.', error: error.message });
  }
};

// ➔ DELETE: Eliminar el registro raíz de la Idea Central una vez vaciada por el frontend
export const deleteIdeaCentral = async (req: Request, res: Response): Promise<void> => {
  const { ideaId } = req.params;

  try {
    // 1. Buscar la idea con todos sus videos antes de eliminarla
    const idea = await IdeaCentral.findById(ideaId);
    if (!idea) {
      res.status(404).json({ message: "La idea central no existe o ya fue eliminada." });
      return;
    }

    const db = mongoose.connection.db;
    if (!db) throw new Error("No hay conexión con la base de datos.");

    const transcriptsCollection = db.collection('transcripts');
    const filesCollection = db.collection('files');

    console.log(`\n=== INICIANDO BORRADO EN GRUPO PARA LA IDEA: ${ideaId} ===`);

    // 2. Iterar de forma limpia sobre todos los videos vinculados de la idea
    if (idea.videos_vinculados && idea.videos_vinculados.length > 0) {
      for (const videoTarget of idea.videos_vinculados) {
        const fileObjectId = new mongoose.Types.ObjectId(String(videoTarget.file_id));

        // A. Borrar Transcripción asociada de su colección
        await transcriptsCollection.deleteOne({ file_id: fileObjectId });

        // B. Obtener la ruta del archivo (priorizando la colección 'files')
        const archivoEnBD = await filesCollection.findOne({ _id: fileObjectId });
        const rutaCruda = archivoEnBD?.file_path || videoTarget.file_path;

        // C. Borrar archivo físico del disco duro de Windows
        if (rutaCruda) {
          const rutaCorregida = rutaCruda.replace(/\\/g, '/');
          const pathABorrar = path.resolve(rutaCorregida);

          if (fs.existsSync(pathABorrar)) {
            try {
              fs.unlinkSync(pathABorrar);
              console.log(`-> [GRUPO] ARCHIVO FÍSICO ELIMINADO: ${pathABorrar}`);
            } catch (fsErr: any) {
              console.error(`-> [GRUPO ERROR DISCO] No se pudo borrar ${pathABorrar}:`, fsErr.message);
            }
          } else {
            console.log(`-> [GRUPO ALERTA] No se encontró en el disco: ${pathABorrar}`);
          }
        }

        // D. Borrar el documento de la colección de archivos 'files'
        await filesCollection.deleteOne({ _id: fileObjectId });
      }
    }

    // 3. Una vez que el disco y las colecciones alternas están 100% limpios, borramos la Idea Central
    await IdeaCentral.findByIdAndDelete(ideaId);
    console.log(`=== BORRADO EN GRUPO FINALIZADO CON ÉXITO ===\n`);

    res.status(200).json({
      success: true,
      message: "La idea y todos los recursos físicos y lógicos asociados se eliminaron en bloque correctamente."
    });

  } catch (error: any) {
    console.error("Error crítico en el backend al eliminar la idea en cascada:", error);
    res.status(500).json({ message: "Error interno del servidor.", error: error.message });
  }
};