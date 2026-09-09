import { db } from './database';

// La revisión que ESTA PC vio por última vez para cada (content_id, plataforma).
//
// La revisión la emite la central (un contador por plataforma que sube con cada
// transición o publicación aplicada). El cliente la necesita para poder
// declarar `baseVersion` al pedir una transición: "decidí esto mirando la
// revisión N".
//
// Lo importante es CUÁNDO se lee, no dónde se guarda. La alternativa obvia
// -- preguntarle la revisión a la central justo antes de entregar -- es
// exactamente el bug que todo esto viene a evitar: convertiría una
// desvinculación decidida ayer, sobre el estado de ayer, en una desvinculación
// aplicada contra el estado de hoy. Si en el medio entró una publicación nueva,
// la borraría. Por eso la revisión se congela al ENCOLAR, no al entregar.
export const platformRevisionRepo = {
  /** 0 si nunca se supo: es lo que la central asume para una plataforma sin transiciones. */
  get(contentId: string, platform: string): number {
    const row = db.prepare(
      'SELECT version FROM platform_revisions WHERE content_id = ? AND platform = ?',
    ).get(contentId, platform) as { version: number } | undefined;
    return row?.version ?? 0;
  },

  /**
   * Solo avanza. Un pull viejo y un pull nuevo pueden llegar en cualquier
   * orden -- y el que llega segundo no es necesariamente el más nuevo. Bajar
   * la revisión haría que la próxima transición declarara una base anterior a
   * la que ya se conocía, y la central la rechazaría por atrasada.
   */
  set(contentId: string, platform: string, version: number): void {
    db.prepare(`
      INSERT INTO platform_revisions (content_id, platform, version, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(content_id, platform) DO UPDATE SET
        version    = MAX(platform_revisions.version, excluded.version),
        updated_at = datetime('now')
    `).run(contentId, platform, version);
  },

  setMany(revisions: { contentId: string; platform: string; version: number }[]): void {
    const aplicar = db.transaction((filas: typeof revisions) => {
      for (const r of filas) {
        if (!r?.contentId || !r?.platform || typeof r.version !== 'number') continue;
        platformRevisionRepo.set(r.contentId, r.platform, r.version);
      }
    });
    aplicar(revisions);
  },
};
