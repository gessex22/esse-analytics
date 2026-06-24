// Instagram Graph API — pendiente de implementación
// Requiere: INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID en .env
//
// Endpoints principales cuando esté listo:
//   GET /{account-id}/media?fields=id,caption,media_type,timestamp,thumbnail_url,
//                                   permalink,like_count,comments_count&access_token=...
//   GET /{media-id}/insights?metric=plays,reach,impressions&access_token=...
//
// Notas:
//   - El token dura 60 días; refrescar antes de expirar con:
//     GET /oauth/access_token?grant_type=fb_exchange_token&...
//   - Los Reels no exponen duración de forma consistente en la API
//   - Matching con archivos locales: por fecha + caption keywords

export async function syncInstagramAccount(): Promise<void> {
  throw new Error('Instagram sync no implementado aún.');
}
