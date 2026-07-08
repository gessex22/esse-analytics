import { Router } from 'express';
import { verifyToken, requirePremium } from '../middleware/auth.middleware';
import { getBackupFiles, bulkUpsertBackupFiles, getBackupStatus, getBackupTranscripts, bulkUpsertBackupTranscripts, getBackupIdeas, getBackupConfig, upsertBackupConfig, getBackupPlatformVideos, bulkUpsertBackupPlatformVideos } from '../controllers/backup.controller';

const router = Router();

// Backup en línea es una gema Premium → guard server-side, no solo en la UI.
router.get('/api/backup/files',           verifyToken, requirePremium, getBackupFiles);
router.post('/api/backup/files/bulk',     verifyToken, requirePremium, bulkUpsertBackupFiles);
router.get('/api/backup/status',          verifyToken, requirePremium, getBackupStatus);
router.get('/api/backup/transcripts',     verifyToken, requirePremium, getBackupTranscripts);
router.post('/api/backup/transcripts/bulk', verifyToken, requirePremium, bulkUpsertBackupTranscripts);
router.get('/api/backup/ideas-centrales', verifyToken, requirePremium, getBackupIdeas);
router.get('/api/backup/config',          verifyToken, requirePremium, getBackupConfig);
router.post('/api/backup/config',         verifyToken, requirePremium, upsertBackupConfig);
router.get('/api/backup/platform-videos',       verifyToken, requirePremium, getBackupPlatformVideos);
router.post('/api/backup/platform-videos/bulk', verifyToken, requirePremium, bulkUpsertBackupPlatformVideos);

export default router;
