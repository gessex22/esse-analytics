// TikTok API — pendiente de implementación
// Requiere aprobación como partner oficial de TikTok:
//   https://developers.tiktok.com/
//
// Endpoints principales cuando esté listo:
//   POST /v2/video/list/   → lista de videos del usuario
//   POST /v2/video/query/  → detalles de videos específicos
//   Campos: id, title, cover_image_url, duration, view_count, like_count,
//           comment_count, share_count, create_time
//
// Notas:
//   - Requiere OAuth 2.0 con scope: video.list
//   - El access_token dura 24h; refresh_token dura 365 días
//   - API muy restrictiva, solo para cuentas aprobadas

export async function syncTikTokAccount(): Promise<void> {
  throw new Error('TikTok sync no implementado aún.');
}
