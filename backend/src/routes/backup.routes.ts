import { Router } from 'express';
import { verifyToken, requirePremium, requireOwner } from '../middleware/auth.middleware';
import { getBackupFiles, bulkUpsertBackupFiles, getBackupStatus, getSyncStatus, getBackupTranscripts, bulkUpsertBackupTranscripts, getBackupIdeas, getBackupConfig, upsertBackupConfig, getBackupPlatformVideos, bulkUpsertBackupPlatformVideos, adminPauseBackupBulk, adminResumeBackupBulk } from '../controllers/backup.controller';

const router = Router();

// Ventana de mantenimiento para el apply global de
// mongo-files-consolidation.js (Entrega B, docs/mongo-collections-consolidation-plan-2026-09-02.md)
// -- solo el owner del servicio, nunca expuesto a un cliente instalado.
router.post('/api/backup/admin/pause-bulk',  verifyToken, requireOwner, adminPauseBackupBulk);
router.post('/api/backup/admin/resume-bulk', verifyToken, requireOwner, adminResumeBackupBulk);

// Backup en línea es una gema Premium → guard server-side, no solo en la UI.
router.get('/api/backup/files',           verifyToken, requirePremium, getBackupFiles);
router.post('/api/backup/files/bulk',     verifyToken, requirePremium, bulkUpsertBackupFiles);
router.get('/api/backup/status',          verifyToken, requirePremium, getBackupStatus);
router.get('/api/backup/sync-status',     verifyToken, requirePremium, getSyncStatus);
router.get('/api/backup/transcripts',     verifyToken, requirePremium, getBackupTranscripts);
router.post('/api/backup/transcripts/bulk', verifyToken, requirePremium, bulkUpsertBackupTranscripts);
router.get('/api/backup/ideas-centrales', verifyToken, requirePremium, getBackupIdeas);
router.get('/api/backup/config',          verifyToken, requirePremium, getBackupConfig);
router.post('/api/backup/config',         verifyToken, requirePremium, upsertBackupConfig);
router.get('/api/backup/platform-videos',       verifyToken, requirePremium, getBackupPlatformVideos);
router.post('/api/backup/platform-videos/bulk', verifyToken, requirePremium, bulkUpsertBackupPlatformVideos);

export default router;
