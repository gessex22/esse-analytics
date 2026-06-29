
import { API_BASE as API_BASE_URL } from "../config";

// ==========================================
// INTERFACES GENERALES DEL COMPONENTE TALLER
// ==========================================

export interface Script {
  hook: string;
  body: string;
  outro: string;
}

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptionSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
  words?: TranscriptionWord[];
}

export interface VideoVersion {
  _id: string;
  title: string;
  duration: string;
  ratio: "16:9" | "9:16";
  uploadedAt: string;
  isMain: boolean;
  thumbnail: string;
  transcription?: TranscriptionSegment[];
}

export interface OriginalVideo {
  _id: string;
  title: string;
  duration: string;
  ratio: "16:9" | "9:16";
  uploadedAt: string;
  thumbnail: string;
  versions: VideoVersion[];
}

export type IdeaStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado';

export interface IdeaCollection {
  _id: string;
  title: string;
  category: string;
  uploadedAt: string;
  script: Script;
  videosOriginales: OriginalVideo[];
  status: IdeaStatus;
}

export type VideoContentStatus = 'publicado' | 'borrador' | 'procesando' | 'descartado' | 'parcial';

export interface VideoPlayerData {
  file: {
    _id: string;
    file_name: string;
    duration_seconds: number;
    formato: string;
    resolucion: string;
  };
  transcript: {
    _id: string;
    transcript_text: string;
    tipo_contenido: string;
    palabras_por_minuto: number;
    language: string;
  } | null;
  script: {
    idea_nucleo: string;
    resumen_visual: string;
  } | null;
}

export interface DashboardVideo {
  _id: string;
  fileId: string;          // _id del documento en la colección 'files' (para rename/status)
  title: string;
  tipoLabel: string;       // Legible: "Guión Estructurado", "Clip Random", etc.
  formato: string;         // Raw del backend: "VERTICAL" | "HORIZONTAL"
  ratio: "9:16" | "16:9";  // Derivado del formato/resolución
  views: string;
  likes: string;
  duration: string;        // "MM:SS" — desde duracion_segundos o estimado
  uploadedAt: string;
  content_status: VideoContentStatus;
  status: "published" | "draft" | "processing"; // legacy, derivado del status técnico
  thumbnail: string;
  category: string;        // tipo_contenido raw
  platforms: ("youtube" | "instagram" | "tiktok" | "facebook")[];
  platforms_discarded: ("youtube" | "instagram" | "tiktok" | "facebook")[];
}

export interface PublishingStatus {
  _id: string;
  fileId: string;
  title: string;
  tiktok_published: boolean;
  instagram_published: boolean;
  youtube_published: boolean;
  createdAt: string;
}

export type CalendarStatus = 'pendiente' | 'parcial' | 'completo';

export interface CalendarVideo {
  _id: string;
  fileId: string;
  title: string;
  date: string;            // ISO date string — effective_date del servidor
  content_status: VideoContentStatus;
  target_platforms: ('youtube' | 'instagram' | 'tiktok' | 'facebook')[];
  published_platforms: ('youtube' | 'instagram' | 'tiktok' | 'facebook')[];
  tipo_contenido: string;
  duracion_segundos?: number;
  calendarStatus: CalendarStatus;
}

export interface PaginationInfo {
  totalRecords: number;
  totalPages: number;
  currentPage: number;
  nextPage: number | null;
  prevPage: number | null;
}

export interface DashboardMetrics {
  totalVideos: number;
  guionesEstructurados: number;
  clipsRandom: number;
  clipsSinVoz: number;
}

// ==========================================
// INTERFACES CORREGIDAS PARA TU MONGODB REAL
// ==========================================

interface ApiVideoVinculado {
  file_id: { $oid: string } | string;
  file_name: string;
  file_path: string;
  fecha_creacion: { $date: string } | string;
  duracion_segundos: number;
  formato: string;
  resolucion: string;
  similitud_guion: number;
  rol: "POR_DEFECTO" | "RELACIONADO";
}

interface ApiIdeaCentralItem {
  _id: string | { $oid: string };
  idea_nucleo: string;
  resumen_visual: string;
  // ➔ Cambiado aquí: El backend lo envía como versionesPrevias en el JSON
  versionesPrevias: ApiVideoVinculado[]; 
  total_renders: number;
  ultima_actualizacion: { $date: string } | string;
}

type ApiVideoStatus = "TRANSCRITO" | "ELIMINADO_DISCO" | "ERROR";

interface ApiVideoItem {
  _id: string;
  file_id?: {
    _id: string;
    file_name: string;
    file_path: string;
    status: ApiVideoStatus;
    duracion_segundos?: number;
    resolucion?: string;
    formato?: string;
    fecha_creacion?: string | { $date: string };
  } | null;
  transcript_text?: string;
  formato?: string;
  duracion_segundos?: number;
  resolucion?: string;
  fecha_creacion?: string | { $date: string };
  tipo_contenido?: "GUION_ESTRUCTURADO" | "CLIP_RANDOM" | "CLIP_SIN_VOZ";
  palabras_por_minuto?: number;
  processed_at?: string;
  platforms?: ("youtube" | "instagram" | "tiktok")[];
}

interface ApiVideosResponse {
  info: PaginationInfo;
  results: ApiVideoItem[];
}
// ==========================================
// FUNCIONES AUXILIARES DE FORMATEO
// ==========================================

const PLACEHOLDER_THUMBNAIL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 180'%3E%3Crect width='320' height='180' fill='%2315151f'/%3E%3Cpath d='M132 91V61l52 30-52 30z' fill='%23ffffff' fill-opacity='.85'/%3E%3C/svg%3E";

function formatDate(date?: any) {
  if (!date) return "Sin fecha";
  const rawDate = typeof date === "object" && "$date" in date ? date.$date : date;
  return new Intl.DateTimeFormat("es", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(rawDate));
}

function formatDuration(text = "", wordsPerMinute = 150) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(15, Math.round((words / Math.max(wordsPerMinute, 1)) * 60));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDurationFromSeconds(seconds = 0) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

const TIPO_LABELS: Record<string, string> = {
  GUION_ESTRUCTURADO: "Guión Estructurado",
  CLIP_RANDOM: "Clip Random",
  CLIP_SIN_VOZ: "Clip sin Voz",
};

function readableTipo(tipo?: string) {
  if (!tipo) return "Contenido";
  return TIPO_LABELS[tipo] ?? tipo.replaceAll("_", " ");
}

function deriveRatio(formato?: string, resolucion?: string): "9:16" | "16:9" {
  if (formato?.toUpperCase() === "VERTICAL") return "9:16";
  if (resolucion) {
    const [w, h] = resolucion.split("x").map(Number);
    if (!isNaN(w) && !isNaN(h) && h > w) return "9:16";
  }
  return "16:9";
}

// ==========================================
// MAPEADORES DE DATOS (DASHBOARD Y TALLER)
// ==========================================

function toDashboardVideo(item: ApiVideoItem): DashboardVideo {
  const file = item.file_id;
  const title = file?.file_name || `Video ${item._id.slice(-6)}`;
  const status: DashboardVideo["status"] =
    file?.status === "ERROR" ? "processing" : file?.status === "ELIMINADO_DISCO" ? "draft" : "published";

  const content_status: VideoContentStatus =
    ((file as any)?.content_status as VideoContentStatus) || "borrador";

  // Duración: usar duracion_segundos real si existe, si no estimar del texto
  const durSeg = item.duracion_segundos ?? file?.duracion_segundos;
  const duration = durSeg != null
    ? formatDurationFromSeconds(durSeg)
    : formatDuration(item.transcript_text, item.palabras_por_minuto);

  const formato = item.formato ?? file?.formato ?? "";
  const resolucion = item.resolucion ?? file?.resolucion;
  const ratio = deriveRatio(formato, resolucion);

  // Fecha de display: fecha_creacion del archivo (real), con fallback a processed_at
  const fechaDisplay =
    item.fecha_creacion ?? item.file_id?.fecha_creacion ?? item.processed_at;

  return {
    _id: item._id,
    fileId: (file as any)?._id ? String((file as any)._id) : "",
    title,
    tipoLabel: readableTipo(item.tipo_contenido),
    formato,
    ratio,
    views: "0",
    likes: "0",
    duration,
    uploadedAt: formatDate(fechaDisplay),
    content_status,
    status,
    thumbnail: PLACEHOLDER_THUMBNAIL,
    category: item.tipo_contenido || "SIN_CATEGORIA",
    platforms:            Array.isArray(item.platforms)            ? item.platforms            : [],
    platforms_discarded:  Array.isArray(item.platforms_discarded)  ? item.platforms_discarded  : [],
  };
}

function toTallerIdeas(items: any[]): IdeaCollection[] {
  const safeItems = Array.isArray(items) ? items : [];

  return safeItems.map((item: any) => {
    // 1. Extraemos y mapeamos la versión principal que calculó el backend (Nivel 2)
    const vp = item.videoPrincipal;
    const mappedMain = vp ? {
      _id: String(vp.id),
      title: vp.name || "Archivo Principal",
      duration: vp.duration, // Ya viene como string del backend ("MM:SS")
      ratio: (vp.format === "VERTICAL" ? "9:16" : "16:9") as "16:9" | "9:16",
      uploadedAt: vp.fecha ? formatDate(vp.fecha) : "Sin fecha",
      isMain: true, // Forzamos a true porque es el principal real
      thumbnail: PLACEHOLDER_THUMBNAIL
    } : null;

    // 2. Mapeamos las versiones alternativas (Nivel 3)
    const alternativos = Array.isArray(item.versionesPrevias) ? item.versionesPrevias : [];
    const mappedAlternates = alternativos.map((v: any) => ({
      _id: String(v.id),
      title: v.name || "Video alternativo",
      duration: v.duration, // Ya viene como string del backend ("MM:SS")
      ratio: (v.format === "VERTICAL" ? "9:16" : "16:9") as "16:9" | "9:16",
      uploadedAt: v.fecha ? formatDate(v.fecha) : "Sin fecha",
      isMain: false, // Son versiones alternativas
      thumbnail: PLACEHOLDER_THUMBNAIL
    }));

    // 3. Unificamos todo el árbol en un array para que Taller.tsx lo renderice perfectamente
    const todasLasVersiones = [];
    if (mappedMain) todasLasVersiones.push(mappedMain);
    todasLasVersiones.push(...mappedAlternates);

    return {
      _id: String(item._id),
      title: item.title || "Idea sin título",
      category: "Taller",
      uploadedAt: item.videoPrincipal?.fecha ? formatDate(item.videoPrincipal.fecha) : "Sin fecha",
      script: {
        hook: item.idea_nucleo ? item.idea_nucleo.slice(0, 140) + "..." : "",
        body: item.idea_nucleo || "",
        outro: "",
      },
      videosOriginales: [
        {
          // El contenedor del nivel 2 adopta los datos del video principal
          _id: mappedMain ? mappedMain._id : String(item._id) + "_bruto",
          title: mappedMain ? mappedMain.title : "Archivos Procesados",
          duration: mappedMain ? mappedMain.duration : "0:00",
          ratio: mappedMain ? mappedMain.ratio : "9:16",
          uploadedAt: mappedMain ? mappedMain.uploadedAt : "Sin fecha",
          thumbnail: PLACEHOLDER_THUMBNAIL,
          versions: todasLasVersiones // Aquí viaja el set completo (Principal + Alternativos)
        }
      ],
      status: (item.status || 'borrador') as IdeaStatus,
    };
  });
}

function toCalendarVideo(item: any): CalendarVideo {
  const targetPlatforms: ('youtube' | 'instagram' | 'tiktok' | 'facebook')[] =
    Array.isArray(item.target_platforms) ? item.target_platforms : [];
  const publishedPlatforms: ('youtube' | 'instagram' | 'tiktok' | 'facebook')[] =
    Array.isArray(item.published_platforms) ? item.published_platforms : [];
  const contentStatus: VideoContentStatus = item.content_status || 'borrador';

  let calendarStatus: CalendarStatus;
  if (contentStatus === 'borrador' || contentStatus === 'procesando') {
    calendarStatus = 'pendiente';
  } else if (targetPlatforms.length === 0) {
    calendarStatus = contentStatus === 'publicado' ? 'completo' : 'pendiente';
  } else {
    const publishedCount = targetPlatforms.filter(p => publishedPlatforms.includes(p)).length;
    if (publishedCount === 0) {
      calendarStatus = 'pendiente';
    } else if (publishedCount < targetPlatforms.length) {
      calendarStatus = 'parcial';
    } else {
      calendarStatus = 'completo';
    }
  }

  return {
    _id: item._id,
    fileId: String(item.fileId || item._id),
    title: item.title || 'Sin título',
    date: item.date,
    content_status: contentStatus,
    target_platforms: targetPlatforms,
    published_platforms: publishedPlatforms,
    tipo_contenido: item.tipo_contenido || '',
    duracion_segundos: item.duracion_segundos,
    calendarStatus,
  };
}

// Base Fetcher HTTP — inyecta el token si existe
function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("esse_auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...getAuthHeader(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || error?.message || `Error HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

// ==========================================
// SERVICIO EXPORTADO DEFINITIVO
// ==========================================

export const videoService = {
  getMetrics: async (): Promise<DashboardMetrics> => {
    return requestJson<DashboardMetrics>("/api/metrics");
  },

  getAllVideos: async (
    page = 1,
    limit = 10,
    filters?: { tipo?: string; content_status?: string }
  ): Promise<{ videos: DashboardVideo[]; info: PaginationInfo }> => {
    let url = `/api/videos?page=${page}&limit=${limit}`;
    if (filters?.tipo)           url += `&tipo=${encodeURIComponent(filters.tipo)}`;
    if (filters?.content_status) url += `&content_status=${encodeURIComponent(filters.content_status)}`;
    const data = await requestJson<ApiVideosResponse>(url);
    return {
      videos: data.results.map(toDashboardVideo),
      info: data.info,
    };
  },

  getSlimList: (): Promise<{ fileId: string; title: string; duration: string }[]> =>
    requestJson('/api/videos/slim'),

  deleteFile: async (fileId: string): Promise<void> => {
    await requestJson(`/api/videos/${fileId}/delete-file`, { method: "DELETE" });
  },

  renameVideo: async (fileId: string, name: string): Promise<void> => {
    await requestJson(`/api/videos/${fileId}/rename`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },

  getVideoPlayerData: async (fileId: string): Promise<VideoPlayerData> => {
    return requestJson<VideoPlayerData>(`/api/videos/${fileId}/player-data`);
  },

  updateVideoPlatforms: async (
    fileId: string,
    platforms: ("youtube" | "instagram" | "tiktok")[],
    platforms_discarded?: ("youtube" | "instagram" | "tiktok")[],
  ): Promise<void> => {
    await requestJson(`/api/videos/${fileId}/platforms`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platforms, platforms_discarded }),
    });
  },

  updateVideoContentStatus: async (fileId: string, status: VideoContentStatus): Promise<void> => {
    await requestJson(`/api/videos/${fileId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  },

  getCalendarVideos: async (year: number, month: number): Promise<CalendarVideo[]> => {
    const data = await requestJson<{ videos: any[] }>(`/api/calendar?year=${year}&month=${month}`);
    return (data.videos || []).map(toCalendarVideo);
  },

  updateScheduledDate: async (fileId: string, date: string | null): Promise<void> => {
    await requestJson(`/api/videos/${fileId}/scheduled-date`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduled_date: date }),
    });
  },

  getTallerIdeas: async (tipo?: 'GUION_ESTRUCTURADO' | 'CLIP_RANDOM'): Promise<IdeaCollection[]> => {
    let url = "/api/ideas-centrales";
    if (tipo) {
      url += `?tipo=${tipo}`;
    }
    const data = await requestJson<ApiIdeaCentralItem[]>(url);
    return toTallerIdeas(data);
  },

  updateIdeaScript: async (ideaId: string, script: Script): Promise<void> => {
    console.info("Edicion local de guion pendiente de endpoint backend", { ideaId, script });
  },

  setMainVersion: async (ideaId: string, versionId: string): Promise<void> => {
    await requestJson(`/api/ideas-centrales/${ideaId}/set-main`, {
      method: "PUT", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId }) 
    });
  },

  // ➔ 1. NUEVA LLAMADA: Elimina la Idea Central raíz (Nivel 1)
  deleteIdeaCentral: async (ideaId: string): Promise<void> => {
    await requestJson(`/api/ideas-centrales/${ideaId}`, {
      method: "DELETE"
    });
  },

  // ➔ 2. NUEVA LLAMADA: Elimina un video individual, su archivo físico y su texto (Nivel 2 y 3)
  deleteVideoIndividual: async (ideaId: string, videoId: string): Promise<void> => {
    await requestJson(`/api/ideas-centrales/${ideaId}/videos/${videoId}`, {
      method: "DELETE"
    });
  },

  // ➔ 3. Actualizar el estado de una idea (publicado, borrador, procesando, descartado)
  updateIdeaStatus: async (ideaId: string, status: IdeaStatus): Promise<void> => {
    await requestJson(`/api/ideas-centrales/${ideaId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  },

  getPublishingStatus: async (): Promise<PublishingStatus[]> => {
    return requestJson<PublishingStatus[]>('/api/publishing-status');
  },

  updatePublishingStatus: async (
    fileId: string,
    updates: Partial<Pick<PublishingStatus, 'tiktok_published' | 'instagram_published' | 'youtube_published'>>,
  ): Promise<PublishingStatus> => {
    return requestJson<PublishingStatus>(`/api/publishing-status/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
};

// ==========================================
// SYNC SERVICE
// ==========================================

export interface SyncCandidate {
  _id: string;
  file_name: string;
  duracion_segundos: number;
  fecha_creacion: string;
  formato: string;
}

export interface SyncReviewItem {
  _id: string;
  platformId: string;
  platformUrl: string;
  title: string;
  thumbnail: string;
  durationSeconds: number;
  publishedAt: string;
  views: number;
  matchScore?: number;
  candidates: SyncCandidate[];
}

export interface SyncReviewResponse {
  total: number;
  page: number;
  totalPages: number;
  items: SyncReviewItem[];
}

export interface SyncStats {
  youtube: number;
  instagram: number;
  tiktok: number;
  linked: number;
  revisar: number;
  sinMatch: number;
}

export const syncService = {
  getStats: (): Promise<SyncStats> =>
    requestJson('/api/sync/stats'),

  getReview: (page = 1): Promise<SyncReviewResponse> =>
    requestJson(`/api/sync/review?page=${page}&limit=15`),

  confirmLink: (pvId: string, fileId: string): Promise<void> =>
    requestJson(`/api/sync/review/${pvId}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    }),

  markOrphan: (pvId: string): Promise<void> =>
    requestJson(`/api/sync/review/${pvId}/orphan`, {
      method: 'POST',
    }),

  triggerSync: (): Promise<{ ok: boolean; total: number; upserted: number }> =>
    requestJson('/api/sync/youtube', { method: 'POST' }),

  getCalendarConfig: (): Promise<{ platform: string; lastPublishedTitle: string; lastPublishedDate: string; intervalDays: number; lastVideoId?: string; nextVideoId?: string; nextVideo?: { fileId: string; title: string; duration: string } | null }[]> =>
    requestJson('/api/sync/calendar-config'),

  getPublishedVideos: (): Promise<{ platform: string; fileName: string | null; platformId: string | null; platformUrl: string | null; publishedAt: string | null }[]> =>
    requestJson('/api/sync/published-videos'),

  updateCalendarConfig: (platform: string, data: { lastPublishedDate?: string; lastPublishedTitle?: string; intervalDays?: number; nextVideoId?: string }): Promise<void> =>
    requestJson(`/api/sync/calendar-config/${platform}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
};

// ==========================================
// BACKUP SERVICE
// ==========================================

export interface BackupLocalStatus {
  localCount: number;
  lastPush: string | null;
  lastPull: string | null;
  lastSync: string | null;
  videosDir: string | null;
}

export interface BackupCloudStatus {
  total: number;
  lastSync: string | null;
}

export interface BackupSyncResult {
  ok: boolean;
  localCount?: number;
  cloudCount?: number;
  updated: number;
  skipped: number;
  orphans?: number;
}

export const backupService = {
  getLocalStatus: (): Promise<BackupLocalStatus> =>
    requestJson('/api/local/backup/status'),

  getCloudStatus: (): Promise<BackupCloudStatus> =>
    requestJson('/api/backup/status'),

  push: (): Promise<BackupSyncResult> =>
    requestJson('/api/local/backup/push', { method: 'POST' }),

  pull: (): Promise<BackupSyncResult> =>
    requestJson('/api/local/backup/pull', { method: 'POST' }),

  // Catálogo (solo nombres/metadatos) desde la nube — para ver tu biblioteca en una
  // máquina que no es la original (sin los .mp4). El local-backend lo proxea a la central.
  getCatalog: (): Promise<{ files: any[]; video_folder?: string | null }> =>
    requestJson('/api/backup/files'),

  // Limpia todos los datos locales y desvincula la instalación.
  // Soft-fail: si algún step falla, continúa igual para no dejar al usuario bloqueado.
  wipeLocalData: async (): Promise<void> => {
    await requestJson('/api/local/wipe', { method: 'POST' }).catch(() => {});
    await requestJson('/api/local/owner/reset', { method: 'POST' }).catch(() => {});
  },
};