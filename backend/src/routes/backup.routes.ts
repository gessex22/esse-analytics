import { Router } from 'express';
import { verifyToken } from '../middleware/auth.middleware';
import { getBackupFiles, bulkUpsertBackupFiles, getBackupStatus, getBackupTranscripts } from '../controllers/backup.controller';

const router = Router();

router.get('/api/backup/files',         verifyToken, getBackupFiles);
router.post('/api/backup/files/bulk',   verifyToken, bulkUpsertBackupFiles);
router.get('/api/backup/status',        verifyToken, getBackupStatus);
router.get('/api/backup/transcripts',   verifyToken, getBackupTranscripts);

export default router;
