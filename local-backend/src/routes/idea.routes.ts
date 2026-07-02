import { Router, Request, Response } from 'express';
import fs from 'fs';
import { fileRepo } from '../db/file.repo';
import { transcriptRepo } from '../db/transcript.repo';
import { publishingStatusRepo } from '../db/publishing-status.repo';
import { ideaRepo, IdeaRol, IdeaStatus } from '../db/idea.repo';

const router = Router();

// Borra el archivo físico + su registro de publicación + su transcript (no borra la fila de `files`,
// mismo criterio que deleteFileFromDisk en video.controller.ts: soft-delete vía status).
function purgeFile(fileId: number) {
  const file = fileRepo.findById(fileId);
  if (!file) return;
  if (fs.existsSync(file.file_path)) {
    try { fs.unlinkSync(file.file_path); } catch { /* ya no está o sin permisos */ }
  }
  fileRepo.update(fileId, { status: 'ELIMINADO_DISCO' });
  publishingStatusRepo.deleteByFileId(fileId);
  transcriptRepo.deleteByFileId(fileId);
}

// ── GET /api/ideas-centrales ──────────────────────────────────────────────────
router.get('/api/ideas-centrales', (req: Request, res: Response) => {
  const tipo = req.query.tipo as string | undefined;
  res.json(ideaRepo.findAllWithVideos(tipo));
});

// ── POST /api/ideas-centrales — usado por el plugin Maiden para crear ideas nuevas ─
router.post('/api/ideas-centrales', (req: Request, res: Response) => {
  const { idea_nucleo, resumen_visual, videos, video_principal_id } = req.body as {
    idea_nucleo?: string;
    resumen_visual?: string;
    videos?: { file_id: number; similitud_guion: number; rol: IdeaRol }[];
    video_principal_id?: number;
  };

  if (!idea_nucleo?.trim() || !Array.isArray(videos) || videos.length === 0 || !video_principal_id) {
    res.status(400).json({ message: 'idea_nucleo, videos y video_principal_id son requeridos.' });
    return;
  }

  const idea = ideaRepo.create({
    idea_nucleo: idea_nucleo.trim(),
    resumen_visual: (resumen_visual ?? idea_nucleo).trim(),
    videos,
    video_principal_id,
  });
  res.status(201).json(idea);
});

// ── PUT /api/ideas-centrales/:ideaId/set-main ─────────────────────────────────
router.put('/api/ideas-centrales/:ideaId/set-main', (req: Request, res: Response) => {
  const { versionId } = req.body as { versionId?: string };
  if (!versionId) { res.status(400).json({ message: 'versionId es requerido.' }); return; }

  const ok = ideaRepo.setMainVersion(req.params.ideaId, versionId);
  if (!ok) { res.status(404).json({ message: 'Idea o versión no encontrada.' }); return; }
  res.json({ message: 'Versión principal actualizada.' });
});

// ── PATCH /api/ideas-centrales/:ideaId/status ─────────────────────────────────
router.patch('/api/ideas-centrales/:ideaId/status', (req: Request, res: Response) => {
  const { status } = req.body as { status?: IdeaStatus };
  const valid: IdeaStatus[] = ['publicado', 'borrador', 'procesando', 'descartado'];
  if (!status || !valid.includes(status)) { res.status(400).json({ message: 'Estado inválido.' }); return; }

  const ok = ideaRepo.updateStatus(req.params.ideaId, status);
  if (!ok) { res.status(404).json({ message: 'Idea no encontrada.' }); return; }
  res.json({ message: 'Estado actualizado.', status });
});

// ── POST /api/ideas-centrales/:ideaId/videos — Maiden suma una versión a una idea existente ─
router.post('/api/ideas-centrales/:ideaId/videos', (req: Request, res: Response) => {
  const { file_id, similitud_guion, rol } = req.body as { file_id?: number; similitud_guion?: number; rol?: IdeaRol };
  if (!file_id) { res.status(400).json({ message: 'file_id es requerido.' }); return; }

  const ok = ideaRepo.addVideo(req.params.ideaId, {
    file_id,
    similitud_guion: similitud_guion ?? 0,
    rol: rol ?? 'RELACIONADO',
  });
  if (!ok) { res.status(404).json({ message: 'Idea no encontrada.' }); return; }
  res.status(201).json({ message: 'Video agregado a la idea.' });
});

// ── DELETE /api/ideas-centrales/:ideaId/videos/:videoId ───────────────────────
router.delete('/api/ideas-centrales/:ideaId/videos/:videoId', (req: Request, res: Response) => {
  const { ideaId, videoId } = req.params;
  const idea = ideaRepo.findById(ideaId);
  if (!idea) { res.status(404).json({ message: 'Idea no encontrada.' }); return; }

  purgeFile(Number(videoId));
  ideaRepo.removeVideo(ideaId, videoId);
  res.json({ message: 'Video eliminado.' });
});

// ── DELETE /api/ideas-centrales/:ideaId ───────────────────────────────────────
router.delete('/api/ideas-centrales/:ideaId', (req: Request, res: Response) => {
  const { ideaId } = req.params;
  const idea = ideaRepo.findById(ideaId);
  if (!idea) { res.status(404).json({ message: 'Idea no encontrada.' }); return; }

  for (const v of ideaRepo.videosOf(ideaId)) {
    purgeFile(v.file_id);
  }
  ideaRepo.delete(ideaId);
  res.json({ message: 'Idea eliminada.' });
});

// ── GET /api/maiden/candidates — guiones sin agrupar, para el plugin Maiden ───
router.get('/api/maiden/candidates', (_req: Request, res: Response) => {
  res.json(ideaRepo.listUnclusteredGuiones());
});

// ── GET /api/maiden/idea-cores — núcleos de ideas existentes, para comparar ───
router.get('/api/maiden/idea-cores', (_req: Request, res: Response) => {
  res.json(ideaRepo.listIdeaCores());
});

export default router;
