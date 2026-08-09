// Datos de fixture compartidos entre escenarios -- el "contenido" de la app
// (videos, stats, calendario) no depende de qué usuario mockeaste, solo el
// acceso/gate sí. Formas tomadas de los tipos reales en services/api.ts.

const THUMB = "https://placehold.co/320x180/1a1a1a/e5e5e5?text=Demo";

export const FIXTURE_METRICS = {
  totalVideos: 42,
  guionesEstructurados: 12,
  clipsRandom: 20,
  clipsSinVoz: 10,
};

export const FIXTURE_VIDEOS_SLIM = [
  { fileId: "mock-1", title: "Cómo editar en 5 minutos", duration: "0:47", platforms: ["youtube", "instagram"], platforms_discarded: [] },
  { fileId: "mock-2", title: "3 tips de storytelling", duration: "1:12", platforms: ["youtube", "instagram", "tiktok"], platforms_discarded: [] },
  { fileId: "mock-3", title: "Behind the scenes", duration: "0:35", platforms: ["tiktok"], platforms_discarded: ["youtube"] },
  { fileId: "mock-4", title: "Draft sin publicar", duration: "2:03", platforms: [], platforms_discarded: [] },
] as const;

function slot(views: number, likes: number, comments: number, platformId: string) {
  return { platformId, platformUrl: `https://example.com/${platformId}`, title: "Demo", thumbnail: THUMB, views, likes, comments };
}

export const FIXTURE_GROUP_STATS = [
  { fileId: "mock-1", fileName: "Cómo editar en 5 minutos", fecha_creacion: "2026-08-01T12:00:00Z", platforms: { youtube: slot(15200, 890, 42, "yt1"), instagram: slot(9800, 1200, 88, "ig1"), tiktok: slot(48000, 5200, 310, "tt1") } },
  { fileId: "mock-2", fileName: "3 tips de storytelling", fecha_creacion: "2026-08-03T12:00:00Z", platforms: { youtube: slot(8100, 410, 20, "yt2"), instagram: slot(6200, 780, 55, "ig2"), tiktok: slot(31000, 2900, 190, "tt2") } },
  { fileId: "mock-3", fileName: "Behind the scenes", fecha_creacion: "2026-08-05T12:00:00Z", platforms: { youtube: slot(4200, 200, 10, "yt3"), instagram: slot(3100, 340, 25, "ig3"), tiktok: slot(19500, 1800, 120, "tt3") } },
];

export const FIXTURE_HISTORY = FIXTURE_GROUP_STATS.flatMap((item, i) =>
  (["youtube", "instagram", "tiktok"] as const).map((platform, j) => ({
    id: i * 3 + j,
    platform,
    platformId: `${platform}-${i}`,
    platformUrl: `https://example.com/${platform}/${i}`,
    publishedAt: item.fecha_creacion,
    title: item.fileName,
    fileName: item.fileName,
    linkedFileId: i + 1,
    matchStatus: "matched",
    deviceId: "mock-device",
    source: "app",
  })),
);

export const FIXTURE_CALENDAR_CONFIG = [
  { platform: "youtube", lastPublishedTitle: "Cómo editar en 5 minutos", lastPublishedDate: "2026-08-01T12:00:00Z", intervalDays: 3, nextVideo: { fileId: "mock-4", title: "Draft sin publicar", duration: "2:03" } },
  { platform: "instagram", lastPublishedTitle: "3 tips de storytelling", lastPublishedDate: "2026-08-03T12:00:00Z", intervalDays: 2, nextVideo: null },
  { platform: "tiktok", lastPublishedTitle: "Behind the scenes", lastPublishedDate: "2026-08-05T12:00:00Z", intervalDays: 1, nextVideo: null },
];

export const FIXTURE_CALENDAR_VIDEOS = [
  { _id: "mock-1", fileId: "mock-1", title: "Cómo editar en 5 minutos", date: "2026-08-01", content_status: "publicado", target_platforms: ["youtube", "instagram"], published_platforms: ["youtube", "instagram"], tipo_contenido: "tutorial", duracion_segundos: 47 },
  { _id: "mock-4", fileId: "mock-4", title: "Draft sin publicar", date: "2026-08-12", content_status: "borrador", target_platforms: ["youtube"], published_platforms: [], tipo_contenido: "tutorial", duracion_segundos: 123 },
];

export const FIXTURE_AUDIT_EVENTS = {
  items: [
    { id: "ae-1", type: "login", createdAt: "2026-08-09T10:00:00Z", installationId: "mock-device", deviceName: "PC de prueba", detail: "Login exitoso" },
    { id: "ae-2", type: "publish_confirmed", createdAt: "2026-08-09T10:05:00Z", installationId: "mock-device", deviceName: "PC de prueba", detail: "Publicado en YouTube" },
    { id: "ae-3", type: "platform_connect", createdAt: "2026-08-08T09:00:00Z", installationId: "mock-device", deviceName: "PC de prueba", detail: "Conectado TikTok" },
  ],
  total: 3,
};

export const FIXTURE_CLOUD_FILES = {
  files: FIXTURE_VIDEOS_SLIM.map((v) => ({
    file_name: v.title,
    platforms: v.platforms,
    platforms_discarded: v.platforms_discarded,
    content_status: v.platforms.length > 0 ? "publicado" : "borrador",
    tipo_contenido: "tutorial",
    duracion_segundos: 60,
    resolucion: "1080x1920",
    formato: "mp4",
    fecha_creacion: "2026-08-01T12:00:00Z",
  })),
  video_folder: "C:/Videos/Demo",
};

export const FIXTURE_USERS = {
  users: [
    { id: "u1", username: "gessem_demo", role: "todopoderoso", tier: "premium", hasCloudStorage: true, status: "active", email: "owner@example.com", linkedPlatforms: ["youtube", "instagram", "tiktok"], youtubeChannel: "Canal Demo", youtubeChannelUrl: "https://youtube.com/@demo", createdAt: "2026-01-01T00:00:00Z" },
    { id: "u2", username: "editor_demo", role: "editor", tier: "free", hasCloudStorage: false, status: "active", email: "editor@example.com", linkedPlatforms: ["tiktok"], tiktokAccount: "@editor.demo", createdAt: "2026-03-15T00:00:00Z" },
    { id: "u3", username: "premium_demo", role: "editor", tier: "premium", hasCloudStorage: true, status: "active", email: "premium@example.com", linkedPlatforms: ["instagram"], instagramAccount: "premium.demo", createdAt: "2026-05-02T00:00:00Z" },
  ],
  total: 3,
};

export const FIXTURE_GEMS = [
  { id: "esse_local_access", status: "running" },
  { id: "esse_backup", status: "installed" },
  { id: "esse_transcrip", status: "not_installed" },
  { id: "esse_remote_access", status: "not_installed" },
  { id: "esse_maiden", status: "not_installed" },
];

export const FIXTURE_BACKUP_STATUS = {
  lastPush: "2026-08-09T09:00:00Z",
  dirty: false,
};
