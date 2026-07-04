import { Router } from 'express';
import { pushToCloud, pullFromCloud, pullTranscriptsFromCloud, getLocalBackupStatus, markSecondaryInstall } from '../controllers/backup-sync.controller';

const router = Router();

router.get('/api/local/backup/status', getLocalBackupStatus);
router.post('/api/local/backup/push',  pushToCloud);
router.post('/api/local/backup/pull',  pullFromCloud);
router.post('/api/local/backup/pull-transcripts', pullTranscriptsFromCloud);
router.post('/api/local/setup/mark-secondary', markSecondaryInstall);

export default router;
