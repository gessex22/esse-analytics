import { db } from './database';

export interface DbTranscript {
  file_id: number;
  text: string;
  language: string;
  created_at: string;
  updated_at: string;
}

export const transcriptRepo = {
  findByFileId(fileId: number | string): DbTranscript | undefined {
    return db.prepare('SELECT * FROM transcripts WHERE file_id = ?')
      .get(Number(fileId)) as DbTranscript | undefined;
  },

  upsert(fileId: number | string, text: string, language = 'es'): DbTranscript {
    db.prepare(`
      INSERT INTO transcripts (file_id, text, language)
        VALUES (?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE
        SET text = excluded.text, language = excluded.language,
            updated_at = datetime('now')
    `).run(Number(fileId), text, language);
    return this.findByFileId(fileId)!;
  },
};
