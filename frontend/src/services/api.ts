
import { API_BASE as API_BASE_URL } from "../config";
import { Upload as TusUpload } from "tus-js-client";

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
  contentId?: string;      // identidad estable del video (files.content_id) — para cruzar con /api/backup/sync-status
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
    content_id?: string;
    file_name: string;
    file_path: string;
    status: ApiVideoStatus;
    content_status?: string;
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
  platforms?: ("youtube" | "instagram" | "tiktok" | "facebook")[];
  platforms_discarded?: ("youtube" | "instagram" | "tiktok" | "facebook")[];
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

export function formatDurationFromSeconds(seconds = 0) {
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

export function deriveRatio(formato?: string, resolucion?: string): "9:16" | "16:9" {
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

  // Duración real (ffprobe/plugin de transcripción). Antes, sin esto se estimaba
  // a partir del largo del texto transcripto — con transcript_text vacío daba
  // siempre "0:15" fijo, un valor falso. Se backfillea sola al abrir el video o
  // generar su miniatura (ver getVideoPlayerData/getVideoThumbnail); hasta que
  // eso pase, mejor mostrar "—" que un número inventado.
  const durSeg = item.duracion_segundos ?? file?.duracion_segundos;
  const duration = durSeg != null ? formatDurationFromSeconds(durSeg) : "—";

  const formato = item.formato ?? file?.formato ?? "";
  const resolucion = item.resolucion ?? file?.resolucion;
  const ratio = deriveRatio(formato, resolucion);

  // Fecha de display: fecha_creacion del archivo (real), con fallback a processed_at
  const fechaDisplay =
    item.fecha_creacion ?? item.file_id?.fecha_creacion ?? item.processed_at;

  return {
    _id: item._id,
    fileId: (file as any)?._id ? String((file as any)._id) : "",
    contentId: file?.content_id,
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

  // Miniatura generada con ffmpeg (local-backend, 100% local por ahora). Es una
  // URL directa para <img src> — no pasa por requestJson porque no es JSON.
  thumbnailUrl: (fileId: string): string => `${API_BASE_URL}/api/videos/${fileId}/thumbnail`,

  // Resuelve file_name → id local (SQLite). Hace falta cuando el fileId viene de
  // la central (Mongo _id, distinto del id local) — ej. candidatos de sync.
  resolveByNames: (names: string[]): Promise<Record<string, string | null>> =>
    requestJson('/api/videos/resolve-by-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names }),
    }),

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

  getSlimList: (): Promise<{ fileId: string; title: string; duration: string; platforms: ("youtube" | "instagram" | "tiktok")[]; platforms_discarded: ("youtube" | "instagram" | "tiktok")[] }[]> =>
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

  // Sube ESTE video puntual a Biblioteca remota (Nube), salteando la cola del
  // calendario -- a diferencia de "Subir" (que publica a una red), esto solo
  // manda los bytes a la nube para poder publicarlo después desde el celular.
  // Solo existe en local-backend (necesita fs para leer el archivo), por eso
  // no vive bajo /api/remote-library/* como el resto del servicio de Nube.
  pushToCloud: async (fileId: string): Promise<{ remoteLibraryVideoId: string }> =>
    requestJson(`/api/videos/${fileId}/push-to-cloud`, { method: "POST" }),

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

  // Links por plataforma de un video puntual — para editarlos inline desde
  // Videos sin ir a la pantalla de Emparejar.
  getPlatformLinks: (fileId: string): Promise<Record<"youtube" | "instagram" | "tiktok", string | null> & {
    statuses?: Record<"youtube" | "instagram" | "tiktok", "con_link" | "sin_link" | "badge_only" | "pendiente">
  }> =>
    requestJson(`/api/videos/${fileId}/platform-links`),

  setPlatformLink: (
    fileId: string,
    platform: "youtube" | "instagram" | "tiktok",
    url: string | null,
  ): Promise<{ platform_url: string | null; platforms: ("youtube" | "instagram" | "tiktok")[] }> =>
    requestJson(`/api/videos/${fileId}/platform-link/${platform}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),

  updateVideosBulk: async (
    fileIds: string[],
    updates: {
      platforms?: ("youtube" | "instagram" | "tiktok")[];
      platformState?: "publicado" | "descartado" | "pendiente";
      tipo_contenido?: string | null;
    },
  ): Promise<{ updated: number }> => {
    return requestJson<{ updated: number }>(`/api/videos/bulk`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds, ...updates }),
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

export interface PlatformRecentItem {
  platformId:  string;
  title:       string;
  thumbnail:   string;
  publishedAt: string;
  platformUrl: string | null;
  stats: Record<string, any>;
}

export interface PlatformRecentPage {
  items: PlatformRecentItem[];
  nextCursor: string | null;
}

export interface CrossMatchItem {
  platform:    string;
  platformId:  string;
  title?:      string;
  thumbnail?:  string;
  publishedAt?: string;
  platformUrl?: string | null;
  stats?: Record<string, any>;
}

export interface CrossMatchResolvedSlot {
  platformId: string;
  platformUrl: string;
  title: string;
  thumbnail: string;
}

export interface CrossMatchCandidate {
  fileId: string;
  fileName: string;
  fecha_creacion: string;
  resolved: {
    youtube: CrossMatchResolvedSlot | null;
    instagram: CrossMatchResolvedSlot | null;
    tiktok: CrossMatchResolvedSlot | null;
  };
}

export interface CrossMatchCandidatesResponse {
  items: CrossMatchCandidate[];
  total: number;
  page: number;
  totalPages: number;
}

export interface GroupStatsSlot {
  platformId: string;
  platformUrl: string;
  title: string;
  thumbnail: string;
  views: number;
  likes: number;
  comments: number;
}

export interface GroupStatsItem {
  fileId: string;
  fileName: string;
  fecha_creacion: string;
  platforms: {
    youtube?: GroupStatsSlot;
    instagram?: GroupStatsSlot;
    tiktok?: GroupStatsSlot;
  };
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

  getPublishedVideos: (): Promise<{ platform: string; fileName: string | null; fileId: string | null; platformId: string | null; platformUrl: string | null; publishedAt: string | null; title?: string | null; status?: string | null; stats?: Record<string, any> }[]> =>
    requestJson('/api/sync/published-videos'),

  // Registro cronológico de todas las subidas hechas desde la app.
  getHistory: (opts: { limit?: number; offset?: number; platform?: string } = {}): Promise<{
    items: { id: number | string; platform: string; platformId: string; platformUrl: string | null; publishedAt: string; title: string | null; fileName: string | null; linkedFileId: number | null; matchStatus: string; deviceId: string | null; source: string | null }[];
    total: number;
  }> => {
    const params = new URLSearchParams();
    params.set('limit', String(opts.limit ?? 30));
    params.set('offset', String(opts.offset ?? 0));
    if (opts.platform) params.set('platform', opts.platform);
    return requestJson(`/api/sync/history?${params.toString()}`);
  },

  updateCalendarConfig: (platform: string, data: { lastPublishedDate?: string; lastPublishedTitle?: string; intervalDays?: number; nextVideoId?: string }): Promise<void> =>
    requestJson(`/api/sync/calendar-config/${platform}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // Página de videos EN VIVO de una plataforma, para el emparejado manual entre
  // redes. Pasar el nextCursor de la respuesta anterior para seguir retrocediendo.
  getPlatformRecent: (platform: string, limit = 20, cursor?: string): Promise<PlatformRecentPage> =>
    requestJson(`/api/sync/platform-recent/${platform}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),

  // Confirma que 2-3 videos (uno por plataforma) son el mismo contenido.
  crossMatch: (items: CrossMatchItem[]): Promise<{ ok: boolean; groupId: string }> =>
    requestJson('/api/sync/cross-match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }),

  // Archivos locales que ya tienen las 3 badges de plataforma — punto de partida
  // para completar los links que falten en vez de adivinar a ciegas.
  getCrossMatchCandidates: (page = 1, limit = 20): Promise<CrossMatchCandidatesResponse> =>
    requestJson(`/api/sync/cross-match/candidates?page=${page}&limit=${limit}`),

  // Confirma que un video puntual de una plataforma es ESTE archivo local.
  resolveCrossMatchSlot: (data: { fileId: string; platform: string } & CrossMatchItem): Promise<void> =>
    requestJson('/api/sync/cross-match/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // Últimos N videos ya matcheados en las 3 plataformas, con stats de cada una.
  getGroupStats: (limit = 5): Promise<{ items: GroupStatsItem[] }> =>
    requestJson(`/api/sync/group-stats?limit=${limit}`),

  // Stats en vivo de UN archivo puntual (por fileId de Mongo o por fileName),
  // sin exigir que esté cross-posteado a las 3 plataformas -- para el card de
  // "último video publicado" del Dashboard, cuando ese video no aparece en
  // getGroupStats por no estar todavía completo en las 3 redes.
  getFileStats: (query: { fileId?: string; fileName?: string }): Promise<GroupStatsItem> => {
    const params = new URLSearchParams();
    if (query.fileId) params.set('fileId', query.fileId);
    if (query.fileName) params.set('fileName', query.fileName);
    return requestJson(`/api/sync/file-stats?${params.toString()}`);
  },

  resolvePublicationSelection: (fileId: string, platforms: Platform[]): Promise<void> =>
    requestJson(`/api/videos/${fileId}/publication-selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platforms }),
    }).then(() => undefined),
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
  isSecondary: boolean;
}

export interface BackupCloudStatus {
  total: number;
  lastSync: string | null;
}

export interface SyncStatusEntry {
  contentId: string;
  metadataBackedUp: boolean;
  inRemoteLibrary: boolean;
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

  // Best-effort igual que getCloudStatus: solo responde cuando el frontend habla
  // directo con la central (modo remoto/web); en Electron/LAN no hay proxy para
  // esta ruta todavía, así que el caller debe tolerar el fallo (.catch(() => null)).
  getSyncStatus: (contentIds: string[]): Promise<{ status: SyncStatusEntry[] }> =>
    requestJson(`/api/backup/sync-status?contentIds=${contentIds.map(encodeURIComponent).join(',')}`),

  push: (): Promise<BackupSyncResult> =>
    requestJson('/api/local/backup/push', { method: 'POST' }),

  pull: (): Promise<BackupSyncResult> =>
    requestJson('/api/local/backup/pull', { method: 'POST' }),

  pullTranscripts: (): Promise<{ ok: boolean; cloudCount: number; recovered: number; skipped: number; orphans: number }> =>
    requestJson('/api/local/backup/pull-transcripts', { method: 'POST' }),

  // Revisa el "próximo" de cada plataforma y sube a Biblioteca remota el que
  // todavía falte (ver ensurePreloadForNextVideos en local-backend). Parte
  // del sync tick, no solo del momento exacto de publicar.
  ensurePreload: (): Promise<{ ok: boolean }> =>
    requestJson('/api/local/backup/ensure-preload', { method: 'POST' }),

  // Catálogo (solo nombres/metadatos) desde la nube — para ver tu biblioteca en una
  // máquina que no es la original (sin los .mp4). El local-backend lo proxea a la central.
  getCatalog: (): Promise<{ files: any[]; video_folder?: string | null }> =>
    requestJson('/api/backup/files'),

  // Marca esta instalación como "no principal": a partir de acá sus pushes nunca
  // reconcilian (fullSync) para no archivar en la nube videos que solo viven en otra PC.
  markSecondary: (): Promise<{ ok: boolean }> =>
    requestJson('/api/local/setup/mark-secondary', { method: 'POST' }),

  // Limpia todos los datos locales y desvincula la instalación.
  // Soft-fail: si algún step falla, continúa igual para no dejar al usuario bloqueado.
  wipeLocalData: async (): Promise<void> => {
    await requestJson('/api/local/wipe', { method: 'POST' }).catch(() => {});
    await requestJson('/api/local/owner/reset', { method: 'POST' }).catch(() => {});
  },
};

// ==========================================
// SETUP SERVICE (preferencias de la instalación)
// ==========================================

export type WorkflowMode = 'simple' | 'avanzado';

export const setupService = {
  // null = todavía no se eligió (instalación vieja o recién creada sin responder aún)
  getWorkflowMode: (): Promise<{ workflowMode: WorkflowMode | null }> =>
    requestJson('/api/local/setup/workflow-mode'),

  setWorkflowMode: (mode: WorkflowMode): Promise<{ ok: boolean; workflowMode: WorkflowMode }> =>
    requestJson('/api/local/setup/workflow-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }),

  // Qué plataformas eligió usar el usuario (Ajustes > Cuentas) — sin elegir
  // todavía, el backend devuelve las 3 (comportamiento de siempre).
  getActivePlatforms: (): Promise<{ activePlatforms: ConnectPlatform[] }> =>
    requestJson('/api/local/setup/active-platforms'),

  setActivePlatforms: (platforms: ConnectPlatform[]): Promise<{ ok: boolean; activePlatforms: ConnectPlatform[] }> =>
    requestJson('/api/local/setup/active-platforms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platforms }),
    }),
};

// ==========================================
// OAUTH SERVICE (conectar/desconectar cuentas — Ajustes > Cuentas)
// ==========================================
// Mismos endpoints que ya usan YoutubeUploadView/SimpleUploadView para el flujo
// de subida (status/url/disconnect), acá centralizados para la pantalla de
// Ajustes que solo necesita mostrar el estado de conexión, no subir nada.

export type ConnectPlatform = "youtube" | "instagram" | "tiktok";

export interface OAuthAccountInfo {
  displayName: string;
  handle?: string;
  avatarUrl: string;
}

const ACCOUNT_INFO_PATH: Record<ConnectPlatform, string> = {
  youtube:   "/api/youtube/channel-info",
  instagram: "/api/instagram/account-info",
  tiktok:    "/api/tiktok/creator-info",
};

export const oauthService = {
  getStatus: (platform: ConnectPlatform): Promise<{ connected: boolean }> =>
    requestJson(`/api/${platform}/auth/status`),

  getAuthUrl: (platform: ConnectPlatform, origin: string): Promise<{ url: string }> =>
    requestJson(`/api/${platform}/auth/url?origin=${encodeURIComponent(origin)}`),

  disconnect: (platform: ConnectPlatform): Promise<void> =>
    requestJson(`/api/${platform}/auth`, { method: "DELETE" }).then(() => undefined),

  // Cada plataforma devuelve un shape distinto (name/nickname, customUrl/username) —
  // se normaliza acá para que la UI no tenga que conocer esas diferencias.
  getAccountInfo: async (platform: ConnectPlatform): Promise<OAuthAccountInfo> => {
    const data = await requestJson<any>(ACCOUNT_INFO_PATH[platform]);
    if (platform === "tiktok") {
      return { displayName: data.nickname || data.username || "", handle: data.username, avatarUrl: data.avatarUrl || "" };
    }
    if (platform === "instagram") {
      return { displayName: data.name || data.username || "", handle: data.username, avatarUrl: data.avatarUrl || "" };
    }
    return { displayName: data.name || "", handle: data.customUrl, avatarUrl: data.avatarUrl || "" };
  },
};

// ==========================================
// BIBLIOTECA REMOTA (Premium + storage en la nube — ver requireCloudStorage)
// ==========================================

export type RemotePlatform = "youtube" | "instagram" | "tiktok";

export interface RemoteLibraryPlatformLink {
  platform: RemotePlatform;
  platformId: string;
  platformUrl?: string;
  publishedAt: string;
}

export interface RemoteLibraryVideo {
  _id: string;
  userId: string;
  fileName: string;
  storedFileName: string | null;
  sizeBytes: number;
  durationSeconds?: number;
  resolution?: string;
  formato?: string;
  thumbnailStoredFileName?: string;
  platforms: RemotePlatform[];
  platformsDiscarded: RemotePlatform[];
  platformLinks?: RemoteLibraryPlatformLink[];
  createdAt: string;
  updatedAt: string;
}

export interface RemoteLibraryPage {
  videos: RemoteLibraryVideo[];
  total: number;
  hasMore: boolean;
}

// Mismo tope que MAX_REMOTE_LIBRARY_VIDEOS en remote-library-quota.service.ts
// (central) -- acá solo para poder deshabilitar el botón de subir de una, sin
// esperar el rechazo del server. La fuente de verdad real sigue siendo el
// backend (ensureRemoteLibraryCapacity); si este número queda desactualizado
// la UI se corrige sola apenas falla la subida.
export const MAX_REMOTE_LIBRARY_VIDEOS = 5;

// tus-js-client envuelve el rechazo del servidor (ej. límite de 5 videos, ver
// remote-library-storage.service.ts) en un DetailedError cuyo .message trae un
// montón de contexto de debug pegado (method/url/response code/request id).
// El body real de la respuesta -- justo el mensaje limpio que arma el backend --
// vive en .originalResponse.getBody(); si no está (error de red antes de
// llegar al server, por ejemplo), cae al .message tal cual.
function extractTusErrorMessage(err: any): string {
  const body: string | undefined = err?.originalResponse?.getBody?.();
  const trimmed = body?.trim();
  return trimmed || err?.message || "No se pudo subir el video.";
}

export const remoteLibraryService = {
  // Paginado -- una cuenta puede tener cientos/miles de videos (ej. después
  // de migrar toda una biblioteca local a Nube), el backend ya no devuelve
  // todo de una (default 30 si no se manda limit).
  list: (params?: { skip?: number; limit?: number }): Promise<RemoteLibraryPage> => {
    const qs = new URLSearchParams();
    if (params?.skip)  qs.set("skip", String(params.skip));
    if (params?.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return requestJson<RemoteLibraryPage>(`/api/remote-library/videos${suffix}`);
  },

  remove: (id: string): Promise<void> =>
    requestJson(`/api/remote-library/videos/${id}`, { method: "DELETE" }).then(() => undefined),

  updatePlatforms: (id: string, patch: { platforms?: RemotePlatform[]; platformsDiscarded?: RemotePlatform[]; platformLinks?: RemoteLibraryPlatformLink[] }): Promise<RemoteLibraryVideo> =>
    requestJson<{ video: RemoteLibraryVideo }>(`/api/remote-library/videos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(d => d.video),

  // El token va por query string por la misma razón que streamUrl en YoutubeUploadView:
  // <video src>/<img src> no mandan headers custom.
  streamUrl: (id: string): string => {
    const token = localStorage.getItem("esse_auth_token");
    return `${API_BASE_URL}/api/remote-library/videos/${id}/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  },
  thumbnailUrl: (id: string): string => {
    const token = localStorage.getItem("esse_auth_token");
    return `${API_BASE_URL}/api/remote-library/videos/${id}/thumbnail${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  },

  uploadThumbnail: (id: string, file: File): Promise<RemoteLibraryVideo> => {
    const form = new FormData();
    form.append("thumbnail", file);
    return requestJson<{ video: RemoteLibraryVideo }>(`/api/remote-library/videos/${id}/thumbnail`, {
      method: "POST",
      body: form,
    }).then(d => d.video);
  },

  // Subida resumable (TUS) -- devuelve el Upload de tus-js-client para que el
  // caller pueda cancelarlo (.abort()); arranca solo, no hace falta .start().
  uploadVideo: (
    file: File,
    meta: { fileName?: string; durationSeconds?: number; resolution?: string; formato?: string; contentId?: string },
    callbacks: { onProgress?: (bytesSent: number, bytesTotal: number) => void; onSuccess: (video: RemoteLibraryVideo) => void; onError: (err: Error) => void },
  ): TusUpload => {
    const token = localStorage.getItem("esse_auth_token");
    const upload = new TusUpload(file, {
      endpoint: `${API_BASE_URL}/api/remote-library/tus`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      metadata: {
        filename: file.name,
        filetype: file.type,
        fileName: meta.fileName || file.name,
        ...(meta.durationSeconds !== undefined ? { durationSeconds: String(meta.durationSeconds) } : {}),
        ...(meta.resolution ? { resolution: meta.resolution } : {}),
        ...(meta.formato ? { formato: meta.formato } : {}),
        // Cuando el video que se sube ya existe en la biblioteca local (files.content_id
        // en SQLite), viaja acá para que la Nube quede vinculada al mismo contenido.
        ...(meta.contentId ? { contentId: meta.contentId } : {}),
      },
      onProgress: callbacks.onProgress,
      onError: (err) => callbacks.onError(new Error(extractTusErrorMessage(err))),
      onSuccess: (payload) => {
        try {
          const data = JSON.parse(payload.lastResponse.getBody());
          callbacks.onSuccess(data.video as RemoteLibraryVideo);
        } catch (err: any) {
          callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    upload.start();
    return upload;
  },
};
