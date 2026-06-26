import { Router } from 'express';
import { verifyToken, requirePremium } from '../middleware/auth.middleware';
import { getBackupFiles, bulkUpsertBackupFiles, getBackupStatus, getBackupTranscripts } from '../controllers/backup.controller';

const router = Router();

// Backup en línea es una gema Premium → guard server-side, no solo en la UI.
router.get('/api/backup/files',         verifyToken, requirePremium, getBackupFiles);
router.post('/api/backup/files/bulk',   verifyToken, requirePremium, bulkUpsertBackupFiles);
router.get('/api/backup/status',        verifyToken, requirePremium, getBackupStatus);
router.get('/api/backup/transcripts',   verifyToken, requirePremium, getBackupTranscripts);

export default router;
