import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  CheckCircle2, ChevronRight, ChevronLeft, Film,
  Search, X, Loader2, Tag, Globe, Lock, Eye,
  CalendarDays, Users, AlertCircle, ExternalLink, RefreshCw, Play, ShieldAlert, Camera,
  UploadCloud, FolderOpen, Sparkles,
} from "lucide-react";

const isRemote = () => {
  const h = window.location.hostname;
  return h !== "localhost" && h !== "127.0.0.1" && !h.startsWith("192.168.");
};
import { videoService, syncService, setupService } from "../services/api";
import { VideoModal } from "./player/VideoModal";
import { API_BASE as API } from "../config";
import { Skeleton } from "./ui/skeleton";
import { ScrollArea } from "./ui/scroll-area";

// El token va por query string porque <video src> no puede mandar headers custom
// (necesario contra la central en modo remoto, que sí valida dueño del archivo).
export function streamUrl(fileId: string): string {
  const token = localStorage.getItem("esse_auth_token");
  return `${API}/api/videos/stream/${fileId}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** Miniatura local del catálogo, con fallback al ícono si todavía no se generó. */
export function VideoThumbnail({ fileId, className = "" }: { fileId: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {!failed && (
        <img
          src={videoService.thumbnailUrl(fileId)}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover ${className}`}
          onError={() => setFailed(true)}
        />
      )}
      {failed && <Film className="w-5 h-5 text-muted-foreground/30" />}
    </>
  );
}

// Placeholder de la tarjeta de cuenta mientras se verifica el estado OAuth
// (evita que el perfil "aparezca de golpe" al terminar la consulta).
export function AccountCardSkeleton() {
  return (
    <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-3">
      <Skeleton className="w-9 h-9 rounded-full flex-shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-32 rounded" />
        <Skeleton className="h-2.5 w-20 rounded" />
      </div>
    </div>
  );
}

// ── Iconos de plataforma ──────────────────────────────────────────────────────
export function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  );
}
export function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>
    </svg>
  );
}
export function TiktokIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.76a4.85 4.85 0 0 1-1.01-.07z"/>
    </svg>
  );
}
export function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
    </svg>
  );
}

// ── Tipos ─────────────────────────────────────────────────────────────────────
export type Platform  = "youtube" | "instagram" | "tiktok";
export type SlimVideo = { fileId: string; title: string; duration: string; platforms?: string[]; platforms_discarded?: string[] };

// Mismo criterio que el Calendario: de la lista local (ya filtrada a lo que
// falta resolver en las 3 plataformas), toma el nextVideoId guardado si sigue
// siendo válido para ESA plataforma puntual; si no hay uno confiable, cae al
// pendiente más viejo (la lista viene de más nuevo a más viejo). Reemplaza la
// resolución vieja que dependía del mirror de archivos en la central — si ese
// mirror no tenía el video (cuenta free, o video nuevo sin sincronizar), "Subir"
// se quedaba sin preselección aunque el Calendario sí supiera cuál era el próximo.
export function resolveNextForPlatform(slim: SlimVideo[], nextVideoId: string | undefined, platform: Platform): SlimVideo | null {
  const list = slim.filter(v => !(v.platforms ?? []).includes(platform) && !(v.platforms_discarded ?? []).includes(platform));
  if (list.length === 0) return null;
  if (nextVideoId) {
    const found = list.find(v => v.fileId === nextVideoId) ?? list.find(v => v.title === nextVideoId);
    if (found) return found;
  }
  return list[list.length - 1];
}
type Privacy   = "public" | "unlisted" | "private";
type Step      = "details" | "visibility" | "uploading" | "done";
type Audience  = "not_kids" | "kids" | "age_restricted";

export const PLATFORMS: { key: Platform; label: string; color: string; Icon: (p: { className?: string }) => JSX.Element }[] = [
  { key: "youtube",   label: "YouTube",   color: "text-red-500",   Icon: YoutubeIcon   },
  { key: "instagram", label: "Instagram", color: "text-pink-500",  Icon: InstagramIcon },
  { key: "tiktok",    label: "TikTok",    color: "text-foreground", Icon: TiktokIcon   },
];

export const YT_CATEGORIES = [
  { id: "1",  label: "Cine y animación"    }, { id: "10", label: "Música"             },
  { id: "20", label: "Videojuegos"         }, { id: "22", label: "Personas y blogs"   },
  { id: "23", label: "Comedia"             }, { id: "24", label: "Entretenimiento"    },
  { id: "27", label: "Educación"           }, { id: "28", label: "Ciencia y tecnología"},
];

const PRIVACY_OPTIONS: { value: Privacy; label: string; desc: string; Icon: typeof Globe }[] = [
  { value: "public",   label: "Público",    desc: "Cualquiera puede ver y buscar este video", Icon: Globe },
  { value: "unlisted", label: "No listado", desc: "Solo accesible con el enlace",             Icon: Eye   },
  { value: "private",  label: "Privado",    desc: "Solo tú puedes verlo",                     Icon: Lock  },
];

// ── Tag input ─────────────────────────────────────────────────────────────────
export function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const add = () => {
    const v = input.trim().replace(/^#/, "");
    if (v && !tags.includes(v)) { onChange([...tags, v]); setInput(""); }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
    if (e.key === "Backspace" && !input && tags.length) onChange(tags.slice(0, -1));
  };
  return (
    <div className="min-h-[72px] border border-border rounded-lg px-3 py-2 bg-secondary/30 flex flex-wrap gap-1.5 cursor-text focus-within:border-primary/50" onClick={() => ref.current?.focus()}>
      {tags.map(t => (
        <span key={t} className="flex items-center gap-1 bg-primary/15 text-primary text-xs px-2 py-0.5 rounded-full">
          #{t} <button type="button" onClick={() => onChange(tags.filter(x => x !== t))}><X className="w-3 h-3" /></button>
        </span>
      ))}
      <input ref={ref} value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKey} onBlur={add}
        placeholder={tags.length ? "" : "Etiquetas (Enter para añadir)"}
        className="flex-1 min-w-[120px] bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none" />
    </div>
  );
}

// ── Modal selector de video ───────────────────────────────────────────────────
// `platform`, si se pasa, habilita la numeración de "cuál sigue": se calcula la
// misma cola que usa resolveNextForPlatform (pendientes para esa red, de más
// viejo a más nuevo, con el nextVideoId fijado del calendario arrancando en 1)
// y se listan primero, numerados — el resto (ya resueltos para esa plataforma)
// quedan sin número más abajo. Sin `platform` se comporta como antes.
export function VideoPickerModal({ onSelect, onClose, platform }: { onSelect: (v: SlimVideo) => void; onClose: () => void; platform?: Platform }) {
  const [videos,  setVideos]  = useState<SlimVideo[]>([]);
  const [search,  setSearch]  = useState("");
  const [loading, setLoading] = useState(true);
  const [nextVideoId, setNextVideoId] = useState<string | undefined>(undefined);

  useEffect(() => {
    videoService.getSlimList().then(setVideos).finally(() => setLoading(false));
    if (platform) {
      syncService.getCalendarConfig()
        .then(configs => setNextVideoId(configs.find(c => c.platform === platform)?.nextVideoId))
        .catch(() => {});
    }
  }, [platform]);

  const queueNumber = new Map<string, number>();
  if (platform) {
    // videos viene de más nuevo a más viejo — la cola de publicación avanza al
    // revés (el más viejo pendiente es el próximo), por eso se invierte acá.
    const pending = videos
      .filter(v => !(v.platforms ?? []).includes(platform) && !(v.platforms_discarded ?? []).includes(platform))
      .reverse();
    if (nextVideoId) {
      const idx = pending.findIndex(v => v.fileId === nextVideoId || v.title === nextVideoId);
      if (idx > 0) pending.unshift(...pending.splice(idx, 1));
    }
    pending.forEach((v, i) => queueNumber.set(v.fileId, i + 1));
  }

  const filtered = videos
    .filter(v => v.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (queueNumber.get(a.fileId) ?? Infinity) - (queueNumber.get(b.fileId) ?? Infinity));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && onClose()}>
      {/* grid (no flex) para el layout general: un ScrollArea de Radix dentro de un
          flex-col con flex-1 no siempre resuelve una altura definida (el viewport
          interno terminaba alto = contenido completo, ignorando el recorte y
          "saliéndose" del modal) — el row 1fr de grid sí le da una altura definida
          a sus hijos de forma consistente entre navegadores. */}
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg grid grid-rows-[auto_auto_1fr]" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center gap-2 p-4 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar video..." className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none" />
          <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground hover:text-foreground" /></button>
        </div>
        {platform && !loading && queueNumber.size > 0 && (
          <p className="px-4 pt-2.5 text-[11px] text-muted-foreground">
            Numerados = orden en que se van a publicar acá. El resto ya está resuelto para esta red.
          </p>
        )}
        <ScrollArea className="min-h-0" type="always">
          {/* Radix exige un único hijo dentro del viewport para medir/recortar bien
              el contenido — pasarle varios <button> sueltos como hermanos rompía el
              recorte y la lista se salía del área con scroll. */}
          <div>
            {loading ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : filtered.slice(0, 100).map(v => {
              const num = queueNumber.get(v.fileId);
              return (
                <button key={v.fileId} onClick={() => { onSelect(v); onClose(); }}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/50 text-left border-b border-border/50 last:border-0">
                  {platform && (
                    <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono font-semibold ${
                      num ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground/50"
                    }`}>
                      {num ?? "–"}
                    </span>
                  )}
                  <div className="w-16 h-10 rounded bg-secondary flex items-center justify-center flex-shrink-0 relative">
                    <VideoThumbnail fileId={v.fileId} />
                    {v.duration && <span className="absolute bottom-0.5 right-0.5 text-[9px] bg-black/80 text-white px-1 rounded font-mono">{v.duration}</span>}
                  </div>
                  <span className={`flex-1 text-sm truncate ${num ? "text-foreground" : "text-muted-foreground"}`}>{v.title}</span>
                </button>
              );
            })}
            {!loading && filtered.length === 0 && <p className="text-center text-muted-foreground text-sm py-8">Sin resultados</p>}
          </div>
        </ScrollArea>
      </motion.div>
    </div>
  );
}

// ── Formulario de subida a TikTok ────────────────────────────────────────────
type TkPrivacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

const TK_PRIVACY_LABELS: Record<TkPrivacy, string> = {
  PUBLIC_TO_EVERYONE:    "Público — Cualquiera puede ver este video",
  MUTUAL_FOLLOW_FRIENDS: "Amigos mutuos — Seguidores que sigues",
  FOLLOWER_OF_CREATOR:   "Seguidores — Solo tus seguidores",
  SELF_ONLY:             "Solo yo — Privado",
};

interface CreatorInfo {
  nickname: string;
  avatarUrl: string;
  username: string;
  privacyOptions: TkPrivacy[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoDurationSec: number;
}

// "M:SS" o "MM:SS" → segundos
function durationToSeconds(d?: string): number {
  if (!d) return 0;
  const parts = d.split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function TikTokUploadForm({ selected, onChangeVideo, onUploaded }: {
  selected: SlimVideo | null;
  onChangeVideo: () => void;
  onUploaded: () => void;
}) {
  const [connected,      setConnected]      = useState<boolean | null>(null);
  const [creator,        setCreator]        = useState<CreatorInfo | null>(null);
  const [creatorLoading, setCreatorLoading] = useState(false);
  const [creatorError,   setCreatorError]   = useState<string | null>(null);

  const [title,          setTitle]          = useState("");
  // Privacidad SIN valor por defecto (obligatorio por las guidelines de TikTok)
  const [privacyLevel,   setPrivacyLevel]   = useState<TkPrivacy | "">("");
  // Interacciones: apagadas por defecto. true = interacción PERMITIDA (allow)
  const [allowComment,   setAllowComment]   = useState(false);
  const [allowDuet,      setAllowDuet]      = useState(false);
  const [allowStitch,    setAllowStitch]    = useState(false);
  // Commercial content disclosure
  const [commercial,     setCommercial]     = useState(false);
  const [brandOrganic,   setBrandOrganic]   = useState(false); // Your Brand
  const [brandedContent, setBrandedContent] = useState(false); // Branded Content

  const [thumbOffsetMs,  setThumbOffsetMs]  = useState<number>(1000);
  const [showScrubber,   setShowScrubber]   = useState(false);
  const [step,           setStep]           = useState<"details" | "uploading" | "done">("details");
  const [publishId,      setPublishId]      = useState<string | null>(null);
  const [sentToInbox,    setSentToInbox]    = useState(false);
  const [uploadError,    setUploadError]    = useState<string | null>(null);
  const [previewVideo,   setPreviewVideo]   = useState<SlimVideo | null>(null);

  const fetchCreatorInfo = () => {
    setCreatorLoading(true);
    setCreatorError(null);
    const token = localStorage.getItem("esse_auth_token");
    fetch(`${API}/api/tiktok/creator-info`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || d.error || "Error");
        setCreator(d);
      })
      .catch(e => setCreatorError(e.message))
      .finally(() => setCreatorLoading(false));
  };

  useEffect(() => {
    const token = localStorage.getItem("esse_auth_token");
    fetch(`${API}/api/tiktok/auth/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json()).then(d => { setConnected(d.connected); if (d.connected) fetchCreatorInfo(); })
      .catch(() => setConnected(false));

    const onMsg = (e: MessageEvent) => {
      if (e.data?.source !== "tiktok_auth") return;
      if (e.data.status === "success") { setConnected(true); setUploadError(null); fetchCreatorInfo(); }
      else setUploadError("Error al conectar con TikTok. Inténtalo de nuevo.");
    };
    window.addEventListener("message", onMsg);

    const params = new URLSearchParams(window.location.search);
    if (params.get("tiktok_auth") === "success") {
      setConnected(true);
      fetchCreatorInfo();
      window.history.replaceState({}, "", window.location.pathname);
    }
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    if (selected) setTitle(selected.title.replace(/\.[^.]+$/, ""));
    setThumbOffsetMs(1000);
    setShowScrubber(false);
  }, [selected?.fileId]);

  // Branded content no puede ser privado → si está en SELF_ONLY, lo desmarcamos
  useEffect(() => {
    if (brandedContent && privacyLevel === "SELF_ONLY") setPrivacyLevel("");
  }, [brandedContent]);

  const recheckTikTok = (): Promise<boolean> => {
    const token = localStorage.getItem("esse_auth_token");
    return fetch(`${API}/api/tiktok/auth/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json())
      .then(d => { setConnected(d.connected); if (d.connected) fetchCreatorInfo(); return !!d.connected; })
      .catch(() => false);
  };

  const connectTikTok = async () => {
    const token = localStorage.getItem("esse_auth_token");
    const res = await fetch(`${API}/api/tiktok/auth/url?origin=${encodeURIComponent(window.location.origin)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const { url } = await res.json();
    const w = 600, h = 720;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top  = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(url, "tk_oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (popup) {
      const poll = setInterval(() => {
        if (popup.closed) { clearInterval(poll); recheckTikTok(); }
      }, 500);
    } else {
      // Ver comentario equivalente en connectInstagram: en Electron no hay
      // ventana real para detectar el cierre, así que reintentamos en el fondo.
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const ok = await recheckTikTok();
        if (ok || attempts >= 40) clearInterval(poll);
      }, 3000);
    }
  };

  // Declaración de consentimiento (cambia según commercial content)
  const consentText = commercial && brandedContent
    ? "Al publicar, aceptas la Política de Contenido de Marca y la Confirmación de Uso de Música de TikTok."
    : "Al publicar, aceptas la Confirmación de Uso de Música de TikTok.";

  // Etiqueta que TikTok aplicará
  const commercialLabel = commercial
    ? (brandedContent ? "Tu video se etiquetará como «Colaboración pagada»"
       : brandOrganic ? "Tu video se etiquetará como «Contenido promocional»" : null)
    : null;

  // Validaciones
  const videoSeconds   = durationToSeconds(selected?.duration);
  const exceedsMaxDur  = creator ? videoSeconds > creator.maxVideoDurationSec : false;
  const commercialBad  = commercial && !brandOrganic && !brandedContent;
  const privacyDisabledForBranded = (p: TkPrivacy) => brandedContent && p === "SELF_ONLY";

  const canPublish = !!connected && !!creator && !!selected && !!title.trim()
    && !!privacyLevel && !commercialBad && !exceedsMaxDur;

  const handleUpload = async () => {
    if (!selected || !privacyLevel) return;
    setUploadError(null);
    setStep("uploading");
    const token = localStorage.getItem("esse_auth_token");
    try {
      const res = await fetch(`${API}/api/tiktok/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          fileId: selected.fileId,
          title,
          privacyLevel,
          // El backend espera "disable*" → invertimos los "allow*"
          disableComment: !allowComment,
          disableDuet:    !allowDuet,
          disableStitch:  !allowStitch,
          brandOrganic:   commercial && brandOrganic,
          brandedContent: commercial && brandedContent,
          thumbOffsetMs,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Error desconocido");
      setPublishId(data.publishId);
      setSentToInbox(data.sentToInbox ?? false);
      setStep("done");
      onUploaded();
    } catch (err: any) {
      setUploadError(err.message);
      setStep("details");
    }
  };

  const reset = () => {
    setStep("details");
    setTitle(selected ? selected.title.replace(/\.[^.]+$/, "") : "");
    setPrivacyLevel("");
    setAllowComment(false); setAllowDuet(false); setAllowStitch(false);
    setCommercial(false); setBrandOrganic(false); setBrandedContent(false);
    setThumbOffsetMs(1000); setShowScrubber(false);
    setUploadError(null); setPublishId(null);
  };

  // Toggle de interacción — grisado si TikTok lo tiene deshabilitado en la cuenta
  const InteractionToggle = ({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled: boolean }) => (
    <div className={`flex items-center justify-between py-2 border-b border-border/50 last:border-0 ${disabled ? "opacity-40" : ""}`}>
      <span className="text-sm text-foreground">{label}{disabled && <span className="text-[10px] text-muted-foreground ml-1.5">(deshabilitado en tu cuenta)</span>}</span>
      <button disabled={disabled} onClick={() => !disabled && onChange(!value)}
        className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${disabled ? "cursor-not-allowed bg-border" : value ? "bg-primary" : "bg-border"}`}>
        <span className={`absolute top-1/2 -translate-y-1/2 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${value && !disabled ? "translate-x-4" : "translate-x-0"}`} />
      </button>
    </div>
  );

  return (
    <div className="space-y-4">

      {/* Video seleccionado (preview) */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Video a publicar</span>
          <button onClick={onChangeVideo} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
            <RefreshCw className="w-3 h-3" /> Cambiar video
          </button>
        </div>
        {selected ? (
          <div className="flex items-center gap-3">
            <button onClick={() => setPreviewVideo(selected)}
              className="w-24 h-14 rounded-lg bg-secondary border border-border flex items-center justify-center flex-shrink-0 relative group hover:border-foreground/20 transition-colors">
              <VideoThumbnail fileId={selected.fileId} className="group-hover:brightness-75 transition" />
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="w-8 h-8 rounded-full bg-black/70 flex items-center justify-center">
                  <Play className="w-4 h-4 text-white fill-white ml-0.5" />
                </div>
              </div>
              {selected.duration && <span className="absolute bottom-1 right-1 text-[9px] bg-black/80 text-white px-1 rounded font-mono">{selected.duration}</span>}
            </button>
            <div className="min-w-0">
              <p className="text-sm text-foreground font-medium truncate">{selected.title}</p>
              <button onClick={() => setPreviewVideo(selected)} className="text-xs text-primary hover:underline mt-0.5">Ver vista previa</button>
            </div>
          </div>
        ) : (
          <button onClick={onChangeVideo}
            className="w-full border-2 border-dashed border-border rounded-lg py-6 text-muted-foreground text-sm hover:border-foreground/20 hover:text-foreground transition-colors">
            Seleccionar video
          </button>
        )}
      </div>

      {/* Estado OAuth */}
      {connected === null && <AccountCardSkeleton />}
      {connected === false && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-300">Cuenta de TikTok no conectada</p>
          </div>
          <button onClick={connectTikTok}
            className="flex items-center gap-1.5 text-xs bg-foreground text-background hover:bg-foreground/90 px-3 py-1.5 rounded-full transition-colors flex-shrink-0 font-medium">
            <TiktokIcon className="w-3.5 h-3.5" /> Conectar
          </button>
        </div>
      )}

      {/* Cuenta conectada — nickname + avatar (requerido por guidelines) */}
      {connected === true && (
        <div className="bg-card border border-border rounded-xl p-3 flex items-center justify-between gap-3">
          {creatorLoading ? (
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <Skeleton className="w-9 h-9 rounded-full flex-shrink-0" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32 rounded" />
                <Skeleton className="h-2.5 w-20 rounded" />
              </div>
            </div>
          ) : creator ? (
            <div className="flex items-center gap-3 min-w-0">
              {creator.avatarUrl
                ? <img src={creator.avatarUrl} alt={creator.nickname} className="w-9 h-9 rounded-full flex-shrink-0 object-cover" />
                : <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center flex-shrink-0"><TiktokIcon className="w-4 h-4 text-foreground" /></div>}
              <div className="min-w-0">
                <p className="text-sm text-foreground font-medium truncate flex items-center gap-1.5">
                  {creator.nickname} <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                </p>
                {creator.username && <p className="text-xs text-muted-foreground truncate">@{creator.username}</p>}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-amber-300">
              <AlertCircle className="w-3.5 h-3.5" /> {creatorError || "No se pudo cargar la cuenta"}
              <button onClick={fetchCreatorInfo} className="text-primary hover:underline ml-1">Reintentar</button>
            </div>
          )}
          <button onClick={async () => {
            const token = localStorage.getItem("esse_auth_token");
            await fetch(`${API}/api/tiktok/auth`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
            setConnected(false); setCreator(null);
          }} className="text-xs text-muted-foreground hover:text-red-400 transition-colors flex-shrink-0">
            Desconectar
          </button>
        </div>
      )}

      {/* Uploading */}
      {step === "uploading" && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center">
            <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}>
              <Loader2 className="w-7 h-7 text-foreground" />
            </motion.div>
          </div>
          <p className="text-foreground font-medium text-sm">Subiendo a TikTok...</p>
          <p className="text-muted-foreground text-xs">Puede tardar unos minutos en procesarse y aparecer en tu perfil</p>
        </div>
      )}

      {/* Done */}
      {step === "done" && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
            <CheckCircle2 className="w-7 h-7 text-emerald-400" />
          </div>
          <div className="text-center">
            <p className="text-foreground font-semibold">
              {sentToInbox ? "Video enviado al inbox" : "¡Video enviado a TikTok!"}
            </p>
            <p className="text-muted-foreground text-xs mt-1 max-w-xs">
              {sentToInbox
                ? "Revisá tu inbox de TikTok para publicarlo desde la app"
                : "Puede tardar unos minutos en procesarse y aparecer en tu perfil"}
            </p>
          </div>
          <button onClick={reset} className="px-5 py-2 rounded-lg border border-border bg-secondary text-sm text-foreground hover:bg-secondary/80 transition-colors">
            Publicar otro
          </button>
        </div>
      )}

      {/* Formulario */}
      {step === "details" && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground">Detalles del video</h3>

          {/* Título */}
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <label className="text-xs font-medium text-muted-foreground">Título *</label>
              <span className={`text-xs font-mono ${title.length > 2000 ? "text-amber-400" : "text-muted-foreground"}`}>{title.length}/2200</span>
            </div>
            <textarea value={title} onChange={e => setTitle(e.target.value.slice(0, 2200))}
              placeholder="Escribe el título del video..." rows={3}
              className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground/30 transition-colors resize-none" />
          </div>

          {/* Privacidad — dropdown SIN valor por defecto (obligatorio) */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Globe className="w-3 h-3" /> Quién puede ver este video *</label>
            <select value={privacyLevel} onChange={e => setPrivacyLevel(e.target.value as TkPrivacy)}
              disabled={!creator}
              className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-foreground/30 appearance-none cursor-pointer disabled:opacity-40">
              <option value="" disabled style={{ background: "#141417", color: "#6b6b7a" }}>Selecciona una opción…</option>
              {(creator?.privacyOptions ?? []).map(p => (
                <option key={p} value={p} disabled={privacyDisabledForBranded(p)} style={{ background: "#141417", color: "#f0f0f2" }}>
                  {TK_PRIVACY_LABELS[p]}{privacyDisabledForBranded(p) ? " (no disponible para contenido de marca)" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Interacciones — apagadas por defecto, grisadas si TikTok las deshabilita */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-2"><Users className="w-3 h-3" /> Permitir interacciones</label>
            <InteractionToggle label="Comentarios" value={allowComment} onChange={setAllowComment} disabled={!!creator?.commentDisabled} />
            <InteractionToggle label="Dueto"       value={allowDuet}    onChange={setAllowDuet}    disabled={!!creator?.duetDisabled} />
            <InteractionToggle label="Stitch"      value={allowStitch}  onChange={setAllowStitch}  disabled={!!creator?.stitchDisabled} />
          </div>

          {/* Commercial content disclosure */}
          <div className="space-y-2 border-t border-border/50 pt-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Divulgar contenido comercial</span>
              </div>
              <button onClick={() => { const v = !commercial; setCommercial(v); if (!v) { setBrandOrganic(false); setBrandedContent(false); } }}
                className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${commercial ? "bg-primary" : "bg-border"}`}>
                <span className={`absolute top-1/2 -translate-y-1/2 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${commercial ? "translate-x-4" : "translate-x-0"}`} />
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground/70">Activa esto si el video promociona una marca, producto o servicio.</p>

            {commercial && (
              <div className="space-y-2 pl-1 pt-1">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" checked={brandOrganic} onChange={e => setBrandOrganic(e.target.checked)}
                    className="mt-0.5 accent-primary" />
                  <div>
                    <p className="text-xs text-foreground font-medium">Tu marca</p>
                    <p className="text-[11px] text-muted-foreground/70">Promocionas tu propio negocio. Se etiqueta como «Contenido promocional».</p>
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" checked={brandedContent} onChange={e => setBrandedContent(e.target.checked)}
                    className="mt-0.5 accent-primary" />
                  <div>
                    <p className="text-xs text-foreground font-medium">Contenido de marca</p>
                    <p className="text-[11px] text-muted-foreground/70">Promocionas a un tercero. Se etiqueta como «Colaboración pagada». No puede ser privado.</p>
                  </div>
                </label>

                {commercialBad && (
                  <p className="text-[11px] text-amber-400 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> Debes indicar si promocionas tu marca, un tercero, o ambos.
                  </p>
                )}
                {commercialLabel && (
                  <p className="text-[11px] text-foreground bg-secondary/60 rounded-lg px-2.5 py-1.5">{commercialLabel}</p>
                )}
              </div>
            )}
          </div>

          {/* Frame de portada */}
          <div className="space-y-2 border-t border-border/50 pt-3">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5" /> Frame de portada
              <span className="ml-auto text-[10px] font-normal opacity-50">opcional</span>
            </label>
            {showScrubber && selected ? (
              <div className="border border-border rounded-xl p-3 space-y-3 bg-secondary/20">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Desliza para elegir el frame</span>
                  <button type="button" onClick={() => setShowScrubber(false)}>
                    <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                  </button>
                </div>
                <ThumbOffsetPicker fileId={selected.fileId}
                  onSelect={offsetSec => { setThumbOffsetMs(Math.round(offsetSec * 1000)); setShowScrubber(false); }} />
              </div>
            ) : (
              <button type="button" onClick={() => selected && setShowScrubber(true)} disabled={!selected}
                className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg py-4 text-muted-foreground text-sm hover:border-foreground/20 hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Camera className="w-4 h-4" />
                {thumbOffsetMs !== 1000 ? `Frame a ${(thumbOffsetMs / 1000).toFixed(1)}s seleccionado — Cambiar` : "Elegir frame de portada"}
              </button>
            )}
          </div>

          {/* Aviso de duración máxima */}
          {exceedsMaxDur && creator && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">El video dura {selected?.duration} pero TikTok permite máximo {Math.floor(creator.maxVideoDurationSec / 60)}:{String(creator.maxVideoDurationSec % 60).padStart(2, "0")} para esta cuenta.</p>
            </div>
          )}

          {uploadError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{uploadError}</p>
            </div>
          )}

          {/* Declaración de consentimiento (obligatoria antes del botón) */}
          <p className="text-[11px] text-muted-foreground/80 leading-relaxed border-t border-border/50 pt-3">{consentText}</p>

          <button onClick={handleUpload} disabled={!canPublish}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            <TiktokIcon className="w-4 h-4" /> Publicar en TikTok
          </button>
        </div>
      )}

      {previewVideo && (
        <VideoModal fileId={previewVideo.fileId} title={previewVideo.title} onClose={() => setPreviewVideo(null)} />
      )}
    </div>
  );
}

// ── Video estático en un timestamp determinado ────────────────────────────────
function VideoStill({ fileId, offsetSeconds, className }: { fileId: string; offsetSeconds: number; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = () => { el.currentTime = offsetSeconds; };
    el.addEventListener("loadedmetadata", handler, { once: true });
    return () => el.removeEventListener("loadedmetadata", handler);
  }, [fileId, offsetSeconds]);
  return (
    <video ref={ref} src={streamUrl(fileId)}
      muted preload="metadata" className={className} />
  );
}

// ── Selector de frame por offset (para Instagram thumb_offset) ────────────────
function ThumbOffsetPicker({ fileId, onSelect }: {
  fileId: string;
  onSelect: (offsetSeconds: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dur,   setDur]   = useState(0);
  const [cur,   setCur]   = useState(0);
  const [ready, setReady] = useState(false);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div className="space-y-3">
      <div className="rounded-lg overflow-hidden bg-black flex items-center justify-center" style={{ maxHeight: 200 }}>
        <video ref={videoRef} src={streamUrl(fileId)}
          muted playsInline preload="metadata"
          className="max-h-[200px] max-w-full object-contain"
          onLoadedMetadata={() => { setDur(videoRef.current?.duration ?? 0); setReady(true); }}
          onTimeUpdate={() => setCur(videoRef.current?.currentTime ?? 0)}
          onSeeked={()    => setCur(videoRef.current?.currentTime ?? 0)}
        />
      </div>
      <div className="space-y-1">
        <input type="range" min={0} max={dur || 100} step={0.1} value={cur}
          onChange={e => { const v = Number(e.target.value); if (videoRef.current) videoRef.current.currentTime = v; }}
          disabled={!ready}
          className="w-full h-1.5 rounded-full accent-pink-500 cursor-pointer disabled:opacity-40"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
          <span>{fmt(cur)}</span>
          <span>{fmt(dur)}</span>
        </div>
      </div>
      <button onClick={() => onSelect(cur)} disabled={!ready}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
        <Camera className="w-4 h-4" />
        Elegir este frame
      </button>
    </div>
  );
}

const TRIM_MAX_SEC = 60;
const TRIM_MIN_SEC = 3;

// Elige el recorte (inicio y fin, hasta 60s de largo) que se usa como 2do intento si
// Instagram rechaza el video completo (cuentas sin el rollout de Reels extendido quedan
// topeadas a 60s vía la API, sin importar el encoding — ver instagram-upload.controller.ts).
// Las dos manijas son independientes: se puede achicar la ventana por debajo de 60s.
function TrimStartPicker({ fileId, durationSec, onSelect }: {
  fileId: string;
  durationSec: number;
  onSelect: (startSeconds: number, durationSeconds: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging  = useRef<"start" | "end" | null>(null);
  const [start, setStart] = useState(0);
  const [end,   setEnd]   = useState(Math.min(durationSec, TRIM_MAX_SEC));
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const seekPreview = (t: number) => { if (videoRef.current) videoRef.current.currentTime = t; };

  const posToTime = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * durationSec;
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const t = posToTime(e.clientX);
      if (dragging.current === "start") {
        // No puede pasar el fin (menos TRIM_MIN_SEC) ni hacer la ventana más larga que 60s.
        const newStart = Math.min(Math.max(0, t), end - TRIM_MIN_SEC);
        const bounded  = Math.max(newStart, end - TRIM_MAX_SEC);
        setStart(bounded);
        seekPreview(bounded);
      } else {
        const newEnd = Math.max(Math.min(t, durationSec), start + TRIM_MIN_SEC);
        const bounded = Math.min(newEnd, start + TRIM_MAX_SEC);
        setEnd(bounded);
        seekPreview(bounded);
      }
    };
    const onUp = () => { dragging.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, durationSec]);

  const startPct = durationSec ? (start / durationSec) * 100 : 0;
  const endPct   = durationSec ? (end   / durationSec) * 100 : 100;
  const clipLen  = end - start;

  return (
    <div className="space-y-3">
      <div className="rounded-lg overflow-hidden bg-black flex items-center justify-center" style={{ maxHeight: 160 }}>
        <video ref={videoRef} src={streamUrl(fileId)}
          muted playsInline preload="metadata"
          className="max-h-[160px] max-w-full object-contain"
        />
      </div>

      <div className="space-y-2 px-2">
        <div ref={trackRef} className="relative h-5 flex items-center select-none touch-none">
          <div className="absolute inset-x-0 h-1.5 rounded-full bg-secondary" />
          <div className="absolute h-1.5 rounded-full bg-amber-500"
            style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
          <div
            onPointerDown={() => { dragging.current = "start"; seekPreview(start); }}
            className="absolute w-4 h-4 rounded-full bg-amber-400 border-2 border-background shadow cursor-grab active:cursor-grabbing"
            style={{ left: `calc(${startPct}% - 8px)` }}
          />
          <div
            onPointerDown={() => { dragging.current = "end"; seekPreview(end); }}
            className="absolute w-4 h-4 rounded-full bg-amber-400 border-2 border-background shadow cursor-grab active:cursor-grabbing"
            style={{ left: `calc(${endPct}% - 8px)` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
          <span>Inicio {fmt(start)}</span>
          <span className="text-amber-400">{clipLen.toFixed(0)}s</span>
          <span>Fin {fmt(end)}</span>
        </div>
        <div className="text-center text-[10px] text-muted-foreground/60">Video completo: {fmt(durationSec)} · máximo 60s por recorte</div>
      </div>

      <button type="button" onClick={() => onSelect(start, clipLen)}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground hover:bg-secondary/80 transition-colors">
        Usar este recorte
      </button>
    </div>
  );
}

// ── Formulario de subida a Instagram ─────────────────────────────────────────
function InstagramUploadForm({ selected, onChangeVideo, onUploaded }: {
  selected: SlimVideo | null;
  onChangeVideo: () => void;
  onUploaded: () => void;
}) {
  const [connected,        setConnected]        = useState<boolean | null>(null);
  const [account,          setAccount]          = useState<{ name: string; username: string; avatarUrl: string } | null>(null);
  const [caption,          setCaption]          = useState("");
  const [tags,             setTags]             = useState<string[]>([]);
  const [thumbOffset,      setThumbOffset]      = useState<number | null>(null);
  const [showScrubber,     setShowScrubber]     = useState(false);
  const [crossPostFacebook, setCrossPostFacebook] = useState(false);
  const [step,             setStep]             = useState<"details" | "uploading" | "done">("details");
  const [doneUrl,          setDoneUrl]          = useState<string | null>(null);
  const [doneFacebook,     setDoneFacebook]     = useState(false);
  const [facebookUrl,      setFacebookUrl]      = useState<string | null>(null);
  const [facebookError,    setFacebookError]    = useState<string | null>(null);
  const [uploadError,      setUploadError]      = useState<string | null>(null);
  const [previewVideo,     setPreviewVideo]     = useState<SlimVideo | null>(null);
  const [uploadStage,      setUploadStage]      = useState<"original" | "recorte-60s" | "recorte-60s+normalizado" | null>(null);
  const [trimStartSec,     setTrimStartSec]     = useState(0);
  const [trimDurationSec,  setTrimDurationSec]  = useState(60);
  const [showTrimEditor,   setShowTrimEditor]   = useState(false);
  // duracion_segundos en la DB solo se completa cuando el plugin de transcripción ya
  // procesó el video — muchos videos recién agregados todavía no la tienen. Por eso medimos
  // la duración real acá con un <video> oculto en vez de confiar solo en selected.duration.
  const [probedDurationSec, setProbedDurationSec] = useState<number | null>(null);
  const probeVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => { setProbedDurationSec(null); }, [selected?.fileId]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const dbDurationSec = durationToSeconds(selected?.duration);
  const videoDurationSec = dbDurationSec > 0 ? dbDurationSec : (probedDurationSec ?? 0);
  const exceedsMetaLimit = videoDurationSec > 60;

  const fetchAccount = () => {
    const token = localStorage.getItem("esse_auth_token");
    fetch(`${API}/api/instagram/account-info`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.json() : null).then(d => d && setAccount(d)).catch(() => {});
  };

  useEffect(() => {
    const token = localStorage.getItem("esse_auth_token");
    fetch(`${API}/api/instagram/auth/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json()).then(d => { setConnected(d.connected); if (d.connected) fetchAccount(); }).catch(() => setConnected(false));

    // Resultado vía popup (postMessage)
    const onMsg = (e: MessageEvent) => {
      if (e.data?.source !== "instagram_auth") return;
      if (e.data.status === "success") {
        setConnected(true);
        setUploadError(null);
        fetchAccount();
      } else if (e.data.status === "no_ig_account") {
        setUploadError("No se encontró una cuenta de Instagram Business vinculada.");
      } else if (e.data.status === "error") {
        setUploadError("Error al conectar con Instagram. Inténtalo de nuevo.");
      }
    };
    window.addEventListener("message", onMsg);

    // Fallback: si el callback redirigió la página completa (no popup)
    const params = new URLSearchParams(window.location.search);
    const authResult = params.get("instagram_auth");
    if (authResult === "success") {
      setConnected(true);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (authResult === "no_ig_account") {
      setUploadError("No se encontró una cuenta de Instagram Business vinculada.");
      window.history.replaceState({}, "", window.location.pathname);
    }

    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    if (selected) setCaption(selected.title.replace(/\.[^.]+$/, ""));
    setThumbOffset(null);
    setShowScrubber(false);
  }, [selected?.fileId]);

  const recheckInstagram = (): Promise<boolean> => {
    const token = localStorage.getItem("esse_auth_token");
    return fetch(`${API}/api/instagram/auth/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json())
      .then(d => { setConnected(d.connected); if (d.connected) fetchAccount(); return !!d.connected; })
      .catch(() => false);
  };

  const connectInstagram = async () => {
    const token = localStorage.getItem("esse_auth_token");
    const res = await fetch(`${API}/api/instagram/auth/url?origin=${encodeURIComponent(window.location.origin)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const { url } = await res.json();
    const w = 600, h = 720;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top  = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(url, "ig_oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (popup) {
      const poll = setInterval(() => {
        if (popup.closed) { clearInterval(poll); recheckInstagram(); }
      }, 500);
    } else {
      // En Electron, setWindowOpenHandler intercepta window.open y lo abre en el
      // navegador externo (shell.openExternal) por seguridad — no hay ventana ni
      // window.opener, así que ni "popup.closed" ni el postMessage del callback
      // pueden avisarnos. Reintentamos el status en el fondo hasta conectar.
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const ok = await recheckInstagram();
        if (ok || attempts >= 40) clearInterval(poll);
      }, 3000);
    }
  };

  const handleUpload = async () => {
    if (!selected) return;
    setUploadError(null);
    setStep("uploading");
    const token = localStorage.getItem("esse_auth_token");
    try {
      const res = await fetch(`${API}/api/instagram/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ fileId: selected.fileId, caption, tags, thumbOffset, crossPostFacebook, trimStartSec, trimDurationSec }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Error desconocido");
      setDoneUrl(data.postUrl);
      setDoneFacebook(crossPostFacebook);
      setFacebookUrl(data.facebookUrl ?? null);
      setFacebookError(data.facebookError ?? null);
      setUploadStage(data.uploadStage ?? null);
      setStep("done");
      onUploaded();
    } catch (err: any) {
      setUploadError(err.message);
      setStep("details");
    }
  };

  const reset = () => {
    setStep("details");
    setCaption(selected ? selected.title.replace(/\.[^.]+$/, "") : "");
    setTags([]); setThumbOffset(null); setShowScrubber(false);
    setUploadError(null); setDoneUrl(null); setDoneFacebook(false); setFacebookUrl(null); setFacebookError(null); setUploadStage(null);
    setTrimStartSec(0); setTrimDurationSec(60); setShowTrimEditor(false);
  };

  return (
    <div className="space-y-4">

      {/* Sondeo oculto de duración real — no depende de duracion_segundos (que solo se
          completa cuando el plugin de transcripción ya procesó el video). */}
      {selected && dbDurationSec === 0 && (
        <video
          ref={probeVideoRef}
          src={streamUrl(selected.fileId)}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={() => setProbedDurationSec(probeVideoRef.current?.duration ?? null)}
        />
      )}

      {/* Video seleccionado */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Video a publicar</span>
          <button onClick={onChangeVideo} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
            <RefreshCw className="w-3 h-3" /> Cambiar video
          </button>
        </div>
        {selected ? (
          <div className="flex items-center gap-3">
            <button onClick={() => setPreviewVideo(selected)}
              className="w-24 h-14 rounded-lg bg-secondary border border-border flex items-center justify-center flex-shrink-0 relative group hover:border-pink-500/50 transition-colors">
              <VideoThumbnail fileId={selected.fileId} className="group-hover:brightness-75 transition" />
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="w-8 h-8 rounded-full bg-black/70 flex items-center justify-center">
                  <Play className="w-4 h-4 text-white fill-white ml-0.5" />
                </div>
              </div>
              {selected.duration && <span className="absolute bottom-1 right-1 text-[9px] bg-black/80 text-white px-1 rounded font-mono">{selected.duration}</span>}
            </button>
            <div className="min-w-0">
              <p className="text-sm text-foreground font-medium truncate">{selected.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Próxima publicación · Instagram</p>
            </div>
          </div>
        ) : (
          <button onClick={onChangeVideo}
            className="w-full border-2 border-dashed border-border rounded-lg py-6 text-muted-foreground text-sm hover:border-pink-500/40 hover:text-foreground transition-colors">
            Seleccionar video
          </button>
        )}
      </div>

      {/* Estado OAuth */}
      {connected === null && <AccountCardSkeleton />}
      {connected === false && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-300">Cuenta de Instagram no conectada</p>
          </div>
          <button onClick={connectInstagram}
            className="flex items-center gap-1.5 text-xs bg-gradient-to-r from-purple-500 to-pink-500 hover:opacity-90 text-white px-3 py-1.5 rounded-full transition-opacity flex-shrink-0">
            <InstagramIcon className="w-3.5 h-3.5" /> Conectar
          </button>
        </div>
      )}
      {connected === true && (
        <div className="bg-card border border-border rounded-xl p-3 flex items-center justify-between gap-3">
          {account ? (
            <div className="flex items-center gap-3 min-w-0">
              {account.avatarUrl
                ? <img src={account.avatarUrl} alt={account.name} className="w-9 h-9 rounded-full flex-shrink-0 object-cover" />
                : <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center flex-shrink-0"><InstagramIcon className="w-4 h-4 text-pink-500" /></div>}
              <div className="min-w-0">
                <p className="text-sm text-foreground font-medium truncate flex items-center gap-1.5">
                  {account.name || account.username} <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                </p>
                {account.username && <p className="text-xs text-muted-foreground truncate">@{account.username}</p>}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> Cuenta de Instagram conectada
            </div>
          )}
          <button
            onClick={async () => {
              const token = localStorage.getItem("esse_auth_token");
              await fetch(`${API}/api/instagram/auth`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
              setConnected(false); setAccount(null);
            }}
            className="text-xs text-muted-foreground hover:text-red-400 transition-colors flex-shrink-0"
          >
            Desconectar
          </button>
        </div>
      )}

      {/* Uploading */}
      {step === "uploading" && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-14 h-14 rounded-2xl bg-pink-500/10 flex items-center justify-center">
            <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}>
              <Loader2 className="w-7 h-7 text-pink-500" />
            </motion.div>
          </div>
          <p className="text-foreground font-medium text-sm">Subiendo a Instagram...</p>
          <p className="text-muted-foreground text-xs">Puede tardar varios minutos</p>
        </div>
      )}

      {/* Done */}
      {step === "done" && (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
            <CheckCircle2 className="w-7 h-7 text-emerald-400" />
          </div>
          <div className="text-center">
            <p className="text-foreground font-semibold">¡Reel publicado!</p>
            <p className="text-muted-foreground text-xs mt-1 truncate max-w-xs">{caption}</p>
          </div>
          {uploadStage && uploadStage !== "original" && (
            <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-full">
              <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
              {uploadStage === "recorte-60s"
                ? "Instagram rechazó el video completo — se publicó recortado a 60 segundos"
                : "Instagram rechazó el video completo — se recortó a 60s y se optimizó automáticamente"}
            </div>
          )}
          <div className="flex flex-col items-center gap-2">
            {doneUrl && (
              <a href={doneUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-pink-400 hover:underline">
                <InstagramIcon className="w-3.5 h-3.5" /> Ver en Instagram <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            {facebookUrl && (
              <a href={facebookUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-blue-400 hover:underline">
                <FacebookIcon className="w-3.5 h-3.5" /> Ver en Facebook <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            {doneFacebook && !facebookUrl && (
              <div className="flex flex-col items-center gap-1 max-w-xs text-center">
                <span className="flex items-center gap-1.5 text-sm text-amber-400">
                  <FacebookIcon className="w-3.5 h-3.5" /> No se pudo publicar en Facebook
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {facebookError ?? "Error desconocido"}
                  {facebookError?.includes("permission") || facebookError?.includes("permiso")
                    ? " — probablemente falte el permiso pages_manage_posts: desconectá y volvé a conectar Instagram."
                    : ""}
                </span>
              </div>
            )}
          </div>
          <button onClick={reset} className="px-5 py-2 rounded-lg border border-border bg-secondary text-sm text-foreground hover:bg-secondary/80 transition-colors">
            Publicar otro
          </button>
        </div>
      )}

      {/* Formulario */}
      {step === "details" && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground">Detalles del Reel</h3>

          {/* Caption */}
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <label className="text-xs font-medium text-muted-foreground">Caption</label>
              <span className={`text-xs font-mono ${caption.length > 2000 ? "text-amber-400" : "text-muted-foreground"}`}>{caption.length}/2200</span>
            </div>
            <textarea value={caption} onChange={e => setCaption(e.target.value.slice(0, 2200))}
              placeholder="Escribe el pie de foto..." rows={4}
              className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-pink-500/50 transition-colors resize-none" />
          </div>

          {/* Hashtags */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" /> Hashtags</label>
            <TagInput tags={tags} onChange={setTags} />
          </div>

          {/* Miniatura (thumb_offset) */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5" /> Frame de portada
              <span className="ml-auto text-[10px] font-normal opacity-50">opcional</span>
            </label>

            {thumbOffset !== null ? (
              <div className="space-y-2">
                <div className="relative rounded-lg overflow-hidden bg-black flex items-center justify-center" style={{ maxHeight: 120 }}>
                  <VideoStill fileId={selected!.fileId} offsetSeconds={thumbOffset}
                    className="max-h-[120px] max-w-full object-contain" />
                  <div className="absolute bottom-1 right-1 text-[10px] bg-black/80 text-white px-1.5 py-0.5 rounded font-mono">
                    {fmt(thumbOffset)}
                  </div>
                  <button type="button" onClick={() => setThumbOffset(null)}
                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/70 flex items-center justify-center hover:bg-black transition-colors">
                    <X className="w-3 h-3 text-white" />
                  </button>
                </div>
                <button type="button" onClick={() => setShowScrubber(true)}
                  className="text-xs text-pink-400 hover:underline flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Cambiar frame
                </button>
              </div>
            ) : showScrubber && selected ? (
              <div className="border border-border rounded-xl p-3 space-y-3 bg-secondary/20">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Desliza para elegir el frame de portada</span>
                  <button type="button" onClick={() => setShowScrubber(false)}>
                    <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                  </button>
                </div>
                <ThumbOffsetPicker fileId={selected.fileId}
                  onSelect={offset => { setThumbOffset(offset); setShowScrubber(false); }} />
              </div>
            ) : (
              <button type="button" onClick={() => selected && setShowScrubber(true)} disabled={!selected}
                className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg py-4 text-muted-foreground text-sm hover:border-pink-500/40 hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Camera className="w-4 h-4" />
                Elegir frame de portada
              </button>
            )}
          </div>

          {/* Recorte de seguridad a 60s — algunas cuentas quedan topeadas a 60s para Reels
              vía la API de Meta; si el video completo falla, se reintenta recortado. */}
          {exceedsMetaLimit && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" /> Recorte de seguridad (por si Instagram rechaza el video completo)
              </label>
              {showTrimEditor && selected ? (
                <div className="border border-border rounded-xl p-3 space-y-3 bg-secondary/20">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Elegí el tramo del recorte (hasta 60s)</span>
                    <button type="button" onClick={() => setShowTrimEditor(false)}>
                      <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                    </button>
                  </div>
                  <TrimStartPicker fileId={selected.fileId} durationSec={videoDurationSec}
                    onSelect={(start, dur) => { setTrimStartSec(start); setTrimDurationSec(dur); setShowTrimEditor(false); }} />
                </div>
              ) : (
                <button type="button" onClick={() => setShowTrimEditor(true)}
                  className="w-full flex items-center justify-between gap-2 border border-border rounded-lg py-2.5 px-3 text-muted-foreground text-xs hover:border-amber-500/40 hover:text-foreground transition-colors">
                  <span>Este video dura {fmt(videoDurationSec)}. Si Instagram lo rechaza, se recorta a {trimDurationSec.toFixed(0)}s desde {fmt(trimStartSec)}.</span>
                  <span className="text-amber-400 flex-shrink-0">Ajustar</span>
                </button>
              )}
            </div>
          )}

          {/* Cross-post a Facebook */}
          <label className="flex items-center gap-3 cursor-pointer select-none group">
            <div className="relative flex-shrink-0">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={crossPostFacebook}
                onChange={e => setCrossPostFacebook(e.target.checked)}
              />
              <div className="w-9 h-5 rounded-full bg-secondary border border-border peer-checked:bg-blue-600 peer-checked:border-blue-600 transition-colors" />
              <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-muted-foreground peer-checked:bg-white peer-checked:translate-x-4 transition-all" />
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                <FacebookIcon className="w-4 h-4 text-blue-400" />
                También publicar en Facebook
              </div>
              <span className="text-[11px] text-muted-foreground/70">
                Se publica aparte en tu Página de Facebook vinculada — no depende de ninguna config de Instagram
              </span>
            </div>
          </label>

          {uploadError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{uploadError}</p>
            </div>
          )}

          <button onClick={handleUpload} disabled={!connected || !selected || !caption.trim()}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-gradient-to-r from-purple-500 to-pink-500 hover:opacity-90 text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
            <InstagramIcon className="w-4 h-4" />
            {crossPostFacebook ? "Publicar en Instagram + Facebook" : "Publicar Reel"}
          </button>
        </div>
      )}

      {previewVideo && (
        <VideoModal fileId={previewVideo.fileId} title={previewVideo.title} onClose={() => setPreviewVideo(null)} />
      )}
    </div>
  );
}

// La miniatura personalizada se captura bien (la vista previa en la app sale
// correcta) pero YouTube la termina mostrando en gris -- no es un bug de este
// código (thumbnails.set devuelve 200 y el pipeline de captura/subida está
// bien: se revisó a fondo el 2026-07-28), sino un delay/quirk conocido del
// lado de YouTube al propagar miniaturas custom por su CDN (reportado por
// usuarios en foros, sin confirmación oficial de Google). Hasta no encontrar
// una forma confiable de evitarlo, se desactiva y se deja el frame
// autoseleccionado random de YouTube -- volver a esto con más tiempo/casos
// reales para confirmar si de verdad es solo un delay o hay algo más.
const CUSTOM_THUMBNAIL_ENABLED = false;

// ── Mini reproductor / capturador de frame ────────────────────────────────────
function ThumbnailScrubber({ fileId, onCapture }: {
  fileId: string;
  onCapture: (blob: Blob, preview: string) => void;
}) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dur,        setDur]        = useState(0);
  const [cur,        setCur]        = useState(0);
  const [ready,      setReady]      = useState(false);
  const [capturing,  setCapturing]  = useState(false);
  const [captureErr, setCaptureErr] = useState(false);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const handleScrub = (val: number) => {
    if (videoRef.current) videoRef.current.currentTime = val;
  };

  const capture = () => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !ready) return;
    setCapturing(true);
    setCaptureErr(false);

    const draw = () => {
      const sourceWidth = video.videoWidth || 720;
      const sourceHeight = video.videoHeight || 1280;
      // YouTube rechaza miniaturas grandes (limite de 2 MB). Mantener el
      // aspecto y limitar el area evita capturas grises en videos verticales.
      const scale = Math.min(1, 1280 / sourceWidth, 720 / sourceHeight);
      canvas.width  = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      try {
        canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          if (blob) {
            onCapture(blob, canvas.toDataURL("image/jpeg", 0.82));
          }
          setCapturing(false);
        }, "image/jpeg", 0.85);
      } catch {
        setCaptureErr(true);
        setCapturing(false);
      }
    };

    // Justo después de un seek el frame puede no estar pintado todavía: dibujar
    // en ese instante captura un cuadro gris a medio decodificar en vez del real.
    // requestVideoFrameCallback espera a que el frame actual ya esté presentado;
    // si el navegador no lo soporta, dos rAF cumplen función similar.
    const win = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof win.requestVideoFrameCallback === "function") {
      win.requestVideoFrameCallback(() => draw());
    } else {
      requestAnimationFrame(() => requestAnimationFrame(draw));
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg overflow-hidden bg-black flex items-center justify-center" style={{ maxHeight: 200 }}>
        <video
          ref={videoRef}
          src={streamUrl(fileId)}
          muted
          playsInline
          preload="metadata"
          crossOrigin="anonymous"
          className="max-h-[200px] max-w-full object-contain"
          onLoadedMetadata={() => { setDur(videoRef.current?.duration ?? 0); setReady(true); }}
          onTimeUpdate={() => setCur(videoRef.current?.currentTime ?? 0)}
          onSeeked={()    => setCur(videoRef.current?.currentTime ?? 0)}
        />
      </div>

      <div className="space-y-1">
        <input
          type="range" min={0} max={dur || 100} step={0.1} value={cur}
          onChange={e => handleScrub(Number(e.target.value))}
          disabled={!ready}
          className="w-full h-1.5 rounded-full accent-red-500 cursor-pointer disabled:opacity-40"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
          <span>{fmt(cur)}</span>
          <span>{fmt(dur)}</span>
        </div>
      </div>

      {captureErr && (
        <p className="text-[11px] text-amber-400 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> Error de CORS al capturar. Recarga la página e inténtalo de nuevo.
        </p>
      )}

      <button
        onClick={capture}
        disabled={!ready || capturing}
        className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-secondary border border-border text-sm text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Camera className="w-4 h-4" />
        {capturing ? "Capturando..." : "Capturar este frame"}
      </button>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}

// ── Componente principal ──────────────────────────────────────────────────────
export function YoutubeUploadView() {
  const [activePlatform, setActivePlatform] = useState<Platform>("youtube");
  // Plataformas que el usuario eligió usar (Ajustes > Cuentas) — las demás no
  // aparecen como pestaña acá, aunque su formulario siga montado por dentro.
  const [visiblePlatforms, setVisiblePlatforms] = useState<Platform[]>(["youtube", "instagram", "tiktok"]);
  useEffect(() => {
    setupService.getActivePlatforms().then(d => {
      if (!d.activePlatforms.length) return;
      setVisiblePlatforms(d.activePlatforms);
      setActivePlatform(prev => d.activePlatforms.includes(prev) ? prev : d.activePlatforms[0]);
    }).catch(() => {});
  }, []);
  const [nextVideos, setNextVideos] = useState<Record<Platform, SlimVideo | null>>({ youtube: null, instagram: null, tiktok: null });
  const [selected,   setSelected]   = useState<SlimVideo | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [connected,  setConnected]  = useState<boolean | null>(null);
  const [channel,    setChannel]    = useState<{ name: string; customUrl: string; avatarUrl: string } | null>(null);
  const [configLoading, setConfigLoading] = useState(true);

  // Pasos del formulario
  const [step,        setStep]        = useState<Step>("details");
  const [title,       setTitle]       = useState("");
  const [description, setDescription] = useState("");
  const [tags,        setTags]        = useState<string[]>([]);
  const [categoryId,  setCategoryId]  = useState("24");
  const [audience,    setAudience]    = useState<Audience>("not_kids");
  const [privacy,     setPrivacy]     = useState<Privacy>("public");
  const [previewVideo,    setPreviewVideo]    = useState<SlimVideo | null>(null);
  const [publishAt,       setPublishAt]       = useState("");
  const [uploadError,     setUploadError]     = useState<string | null>(null);
  const [doneUrl,         setDoneUrl]         = useState<string | null>(null);
  const [thumbnailBlob,   setThumbnailBlob]   = useState<Blob | null>(null);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);
  const [showScrubber,    setShowScrubber]    = useState(false);
  const [thumbnailError,  setThumbnailError]  = useState<string | null>(null);
  const [doneVideoId,     setDoneVideoId]     = useState<string | null>(null);
  const [retryingThumb,   setRetryingThumb]   = useState(false);
  // En remoto (owner) publicamos desde el catálogo de la central por fileId, no por
  // archivo del dispositivo. El selector de fuente (línea ~1355) solo se ve en local.
  const [videoSource,     setVideoSource]     = useState<"library" | "device">("library");
  const [localFile,       setLocalFile]       = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Carga (o recarga) el "próximo video" por plataforma. Se usa al montar y después
  // de cada upload exitoso, para que la tarjeta avance al siguiente video real en
  // vez de seguir mostrando el que se acaba de subir.
  const loadNextVideos = () => {
    return Promise.all([
      syncService.getCalendarConfig(),
      videoService.getSlimList().catch(() => [] as SlimVideo[]),
    ])
      .then(([configs, slim]) => {
        const map: Record<Platform, SlimVideo | null> = { youtube: null, instagram: null, tiktok: null };
        for (const p of ["youtube", "instagram", "tiktok"] as Platform[]) {
          const cfg = configs.find(c => c.platform === p);
          map[p] = resolveNextForPlatform(slim, cfg?.nextVideoId, p);
        }
        setNextVideos(map);
        return map;
      });
  };

  // Tras un upload exitoso: recarga el próximo video y actualiza la selección de la
  // plataforma activa para que la tarjeta refleje el video correcto de inmediato.
  const refreshAfterUpload = (platform: Platform) => {
    loadNextVideos().then(map => {
      if (platform === activePlatform) {
        setSelected(map[platform]);
        setTitle(map[platform] ? map[platform]!.title.replace(/\.[^.]+$/, "") : "");
      }
    }).catch(() => {});
  };

  useEffect(() => {
    loadNextVideos()
      .then(map => {
        // Pre-selecciona el de youtube
        if (map.youtube) {
          setSelected(map.youtube);
          setTitle(map.youtube.title.replace(/\.[^.]+$/, ""));
        }
      })
      .finally(() => setConfigLoading(false));

    const token = localStorage.getItem("esse_auth_token");
    fetch(`${API}/api/youtube/auth/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json()).then(d => { setConnected(d.connected); if (d.connected) fetchChannel(); }).catch(() => setConnected(false));

    // Verifica callback OAuth
    const params = new URLSearchParams(window.location.search);
    if (params.get("youtube_auth") === "success") {
      setConnected(true);
      fetchChannel();
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const fetchChannel = () => {
    const token = localStorage.getItem("esse_auth_token");
    fetch(`${API}/api/youtube/channel-info`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => {
        // Token guardado pero inválido (invalid_grant, revocado): no dejar la UI
        // en un estado a medias "conectado" sin ícono — mostrar el botón de conectar.
        if (r.status === 401) { setConnected(false); return null; }
        return r.ok ? r.json() : null;
      })
      .then(d => d && setChannel(d)).catch(() => {});
  };

  // Al cambiar de plataforma, pre-selecciona su nextVideo
  const youtubeDraftRef = useRef<{
    selected: SlimVideo | null; title: string; description: string; tags: string[];
    categoryId: string; audience: Audience; privacy: Privacy; publishAt: string;
  } | null>(null);

  const switchPlatform = (p: Platform) => {
    if (p === activePlatform) return;
    if (activePlatform === "youtube") {
      youtubeDraftRef.current = { selected, title, description, tags, categoryId, audience, privacy, publishAt };
    }
    setActivePlatform(p);
    setStep("details");
    setUploadError(null);
    if (p === "youtube" && youtubeDraftRef.current) {
      const draft = youtubeDraftRef.current;
      setSelected(draft.selected); setTitle(draft.title); setDescription(draft.description);
      setTags(draft.tags); setCategoryId(draft.categoryId); setAudience(draft.audience);
      setPrivacy(draft.privacy); setPublishAt(draft.publishAt);
      return;
    }
    const v = nextVideos[p];
    if (v) {
      setSelected(v);
      setTitle(v.title.replace(/\.[^.]+$/, ""));
    } else {
      setSelected(null);
      setTitle("");
    }
  };

  const connectYoutube = async () => {
    const token = localStorage.getItem("esse_auth_token");
    const res = await fetch(`${API}/api/youtube/auth/url?origin=${encodeURIComponent(window.location.origin)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const { url } = await res.json();
    window.location.href = url;
  };

  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectYoutube = async () => {
    if (!window.confirm("¿Desconectar tu cuenta de YouTube? Tendrás que volver a vincularla para subir videos.")) return;
    setDisconnecting(true);
    const token = localStorage.getItem("esse_auth_token");
    try {
      await fetch(`${API}/api/youtube/auth`, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      setConnected(false);
      setChannel(null);
    } finally {
      setDisconnecting(false);
    }
  };

  // YouTube puede tardar unos segundos en terminar de procesar el video recién
  // subido; si se intenta fijar la miniatura antes de eso la llamada falla, y
  // como antes no se revisaba res.ok el error quedaba invisible: el usuario
  // veía "publicado" pero YouTube terminaba mostrando un frame autoseleccionado
  // random en vez de la miniatura elegida. Reintentamos brevemente y, si sigue
  // fallando, lo avisamos en vez de tragarnos el error.
  const uploadThumbnail = async (videoId: string, blob: Blob, authHeader: Record<string, string>) => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target?.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    let lastError = "Error desconocido";
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 5000));
      try {
        const res = await fetch(`${API}/api/youtube/thumbnail/${videoId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify({ imageBase64: base64 }),
        });
        if (res.ok) return;
        const errData = await res.json().catch(() => ({}));
        lastError = errData.detail || errData.error || `Error ${res.status}`;
      } catch (err: any) {
        lastError = err.message || "Error de red";
      }
    }
    throw new Error(lastError);
  };

  const retryThumbnail = async () => {
    if (!doneVideoId || !thumbnailBlob) return;
    setRetryingThumb(true);
    const token = localStorage.getItem("esse_auth_token");
    const authHeader = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      await uploadThumbnail(doneVideoId, thumbnailBlob, authHeader);
      setThumbnailError(null);
    } catch (err: any) {
      setThumbnailError(err.message);
    } finally {
      setRetryingThumb(false);
    }
  };

  const handleUpload = async () => {
    setUploadError(null);
    setThumbnailError(null);
    setStep("uploading");
    const token = localStorage.getItem("esse_auth_token");
    const authHeader = token ? { Authorization: `Bearer ${token}` } : {};

    try {
      let data: any;

      if (videoSource === "device" && localFile) {
        // Upload remoto: archivo desde el dispositivo
        const form = new FormData();
        form.append("video", localFile);
        form.append("title", title);
        form.append("description", description);
        form.append("tags", JSON.stringify(tags));
        form.append("categoryId", categoryId);
        form.append("privacyStatus", publishAt ? "private" : privacy);
        form.append("madeForKids", String(audience === "kids"));
        form.append("ageRestricted", String(audience === "age_restricted"));
        if (publishAt) form.append("publishAt", publishAt);

        const res = await fetch(`${API}/api/youtube/upload/remote`, {
          method: "POST",
          headers: authHeader,
          body: form,
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.detail || data.error || "Error desconocido");
      } else {
        // Upload local: fileId en disco
        if (!selected) return;
        const res = await fetch(`${API}/api/youtube/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify({ fileId: selected.fileId, title, description, tags, categoryId, privacyStatus: privacy, madeForKids: audience === "kids", ageRestricted: audience === "age_restricted", publishAt: publishAt || undefined }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.detail || data.error || "Error desconocido");

        // Miniatura capturada (solo en modo biblioteca)
        if (CUSTOM_THUMBNAIL_ENABLED && videoSource !== "device" && thumbnailBlob && data.videoId) {
          try {
            await uploadThumbnail(data.videoId, thumbnailBlob, authHeader);
          } catch (err: any) {
            // No bloquea el flujo de publicación, pero se avisa en la pantalla
            // final en vez de dejar la miniatura fallando en silencio.
            setThumbnailError(err.message);
          }
        }
      }

      if (CUSTOM_THUMBNAIL_ENABLED && videoSource === "device" && thumbnailBlob && data.videoId) {
        try {
          await uploadThumbnail(data.videoId, thumbnailBlob, authHeader);
        } catch (err: any) {
          setThumbnailError(err.message);
        }
      }

      setDoneVideoId(data.videoId ?? null);
      setDoneUrl(data.videoUrl);
      setStep("done");
      refreshAfterUpload("youtube");
    } catch (err: any) {
      setUploadError(err.message);
      setStep("visibility");
    }
  };

  const reset = () => {
    setStep("details");
    const v = nextVideos[activePlatform];
    setSelected(v);
    setTitle(v ? v.title.replace(/\.[^.]+$/, "") : "");
    setDescription(""); setTags([]); setCategoryId("24");
    setAudience("not_kids"); setPrivacy("public"); setPublishAt("");
    setUploadError(null); setDoneUrl(null); setDoneVideoId(null);
    setThumbnailBlob(null); setThumbnailPreview(null); setShowScrubber(false); setThumbnailError(null);
    setLocalFile(null);
  };

  const plat = PLATFORMS.find(p => p.key === activePlatform)!;

  return (
    <div className="space-y-5 max-w-4xl mx-auto">

      {/* ── Tabs de plataforma ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 bg-card border border-border rounded-xl p-1.5">
        {PLATFORMS.filter(p => visiblePlatforms.includes(p.key)).map(p => {
          const active = activePlatform === p.key;
          return (
            <button key={p.key} onClick={() => switchPlatform(p.key)}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                active ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <p.Icon className={`w-4 h-4 ${active ? p.color : ""}`} />
              <span className="hidden sm:inline">{p.label}</span>
            </button>
          );
        })}
      </div>

      {/* Instagram y TikTok quedan SIEMPRE montados (solo ocultos por CSS) — antes se
          desmontaban al cambiar de pestaña (dentro del motion.div con key={activePlatform}),
          lo que borraba caption/tags/recorte porque cada uno guarda su estado internamente. */}
      <div className={activePlatform === "instagram" ? "" : "hidden"}>
        <InstagramUploadForm
          selected={selected}
          onChangeVideo={() => setShowPicker(true)}
          onUploaded={() => refreshAfterUpload("instagram")}
        />
      </div>
      <div className={activePlatform === "tiktok" ? "" : "hidden"}>
        <TikTokUploadForm
          selected={selected}
          onChangeVideo={() => setShowPicker(true)}
          onUploaded={() => refreshAfterUpload("tiktok")}
        />
      </div>

      {/* ── Contenido de YouTube (vive inline en este componente, su estado ya
          persiste en el padre — no hace falta sacarlo del wrapper animado) ──────── */}
      <AnimatePresence mode="wait">
        <motion.div key={activePlatform} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>

          {/* YouTube */}
          {activePlatform === "youtube" && (
            <div className="space-y-4">

              {/* Video a publicar */}
              <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Video a publicar</span>

                {/* Toggle fuente — solo en modo local */}
                {!isRemote() && (
                  <div className="flex items-center gap-1 bg-secondary/60 rounded-lg p-1">
                    {(["library", "device"] as const).map(src => (
                      <button key={src} onClick={() => { setVideoSource(src); setLocalFile(null); setSelected(null); setTitle(""); }}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          videoSource === src ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                        }`}>
                        {src === "library" ? <><FolderOpen className="w-3.5 h-3.5" /> Biblioteca</> : <><UploadCloud className="w-3.5 h-3.5" /> Desde dispositivo</>}
                      </button>
                    ))}
                  </div>
                )}

                {/* Modo: biblioteca local */}
                {videoSource === "library" && (
                  <>
                    <div className="flex items-center justify-end">
                      <button onClick={() => setShowPicker(true)} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
                        <RefreshCw className="w-3 h-3" /> Cambiar video
                      </button>
                    </div>
                    {configLoading ? (
                      <div className="flex items-center gap-3 animate-pulse">
                        <div className="w-24 h-14 rounded-lg bg-secondary" />
                        <div className="space-y-2 flex-1">
                          <div className="h-3 bg-secondary rounded w-3/4" />
                          <div className="h-3 bg-secondary rounded w-1/4" />
                        </div>
                      </div>
                    ) : selected ? (
                      <div className="flex items-center gap-3">
                        <button onClick={() => setPreviewVideo(selected)}
                          className="w-24 h-14 rounded-lg bg-secondary border border-border flex items-center justify-center flex-shrink-0 relative group hover:border-primary/50 transition-colors">
                          <VideoThumbnail fileId={selected.fileId} className="group-hover:brightness-75 transition" />
                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <div className="w-8 h-8 rounded-full bg-black/70 flex items-center justify-center">
                              <Play className="w-4 h-4 text-white fill-white ml-0.5" />
                            </div>
                          </div>
                          {selected.duration && <span className="absolute bottom-1 right-1 text-[9px] bg-black/80 text-white px-1 rounded font-mono">{selected.duration}</span>}
                        </button>
                        <div className="min-w-0">
                          <p className="text-sm text-foreground font-medium truncate">{selected.title}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Próxima publicación · YouTube</p>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setShowPicker(true)}
                        className="w-full border-2 border-dashed border-border rounded-lg py-6 text-muted-foreground text-sm hover:border-primary/40 hover:text-foreground transition-colors">
                        Seleccionar video
                      </button>
                    )}
                  </>
                )}

                {/* Modo: desde dispositivo */}
                {videoSource === "device" && (
                  <>
                    <input ref={fileInputRef} type="file" accept="video/*" className="hidden"
                      onChange={e => {
                        const f = e.target.files?.[0] ?? null;
                        setLocalFile(f);
                        if (f) setTitle(f.name.replace(/\.[^.]+$/, ""));
                      }} />
                    {localFile ? (
                      <div className="flex items-center gap-3 p-3 bg-secondary/40 rounded-xl border border-border">
                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <Film className="w-5 h-5 text-primary/60" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground font-medium truncate">{localFile.name}</p>
                          <p className="text-xs text-muted-foreground">{(localFile.size / 1024 / 1024).toFixed(1)} MB</p>
                        </div>
                        <button onClick={() => { setLocalFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                          className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => fileInputRef.current?.click()}
                        className="w-full border-2 border-dashed border-border rounded-xl py-8 flex flex-col items-center gap-2 text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors">
                        <UploadCloud className="w-7 h-7" />
                        <span className="text-sm">Elegir archivo de video</span>
                        <span className="text-xs opacity-60">MP4, MOV, AVI · máx. 500 MB</span>
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Estado OAuth */}
              {connected === null && <AccountCardSkeleton />}
              {connected === false && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-300">Cuenta de YouTube no conectada</p>
                  </div>
                  <button onClick={connectYoutube}
                    className="flex items-center gap-1.5 text-xs bg-red-500 hover:bg-red-400 text-white px-3 py-1.5 rounded-full transition-colors flex-shrink-0">
                    <YoutubeIcon className="w-3.5 h-3.5" /> Conectar
                  </button>
                </div>
              )}
              {connected === true && (
                <div className="bg-card border border-border rounded-xl p-3 flex items-center justify-between gap-3">
                  {channel ? (
                    <div className="flex items-center gap-3 min-w-0">
                      {channel.avatarUrl
                        ? <img src={channel.avatarUrl} alt={channel.name} className="w-9 h-9 rounded-full flex-shrink-0 object-cover" />
                        : <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center flex-shrink-0"><YoutubeIcon className="w-4 h-4 text-red-500" /></div>}
                      <div className="min-w-0">
                        <p className="text-sm text-foreground font-medium truncate flex items-center gap-1.5">
                          {channel.name} <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                        </p>
                        {channel.customUrl && <p className="text-xs text-muted-foreground truncate">{channel.customUrl}</p>}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Cuenta de YouTube conectada
                    </div>
                  )}
                  <button
                    onClick={disconnectYoutube}
                    disabled={disconnecting}
                    title="Desconectar cuenta de YouTube"
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-red-400 border border-border hover:border-red-500/40 px-3 py-1.5 rounded-full transition-colors flex-shrink-0 disabled:opacity-50"
                  >
                    {disconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                    Desconectar
                  </button>
                </div>
              )}

              {/* ── Formulario multi-paso ─────────────────────────────────── */}
              <AnimatePresence mode="wait">

                {/* Uploading */}
                {step === "uploading" && (
                  <motion.div key="uploading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="flex flex-col items-center justify-center py-16 gap-4">
                    <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center">
                      <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.2, ease: "linear" }}>
                        <Loader2 className="w-7 h-7 text-red-500" />
                      </motion.div>
                    </div>
                    <p className="text-foreground font-medium text-sm">Subiendo a YouTube...</p>
                    <p className="text-muted-foreground text-xs">Puede tardar varios minutos</p>
                  </motion.div>
                )}

                {/* Done */}
                {step === "done" && (
                  <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center justify-center py-16 gap-4">
                    <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                      <CheckCircle2 className="w-7 h-7 text-emerald-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-foreground font-semibold">¡Video publicado!</p>
                      <p className="text-muted-foreground text-xs mt-1 truncate max-w-xs">{title}</p>
                    </div>
                    {doneUrl && (
                      <a href={doneUrl} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-sm text-primary hover:underline">
                        Ver en YouTube <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    {thumbnailError && (
                      <div className="flex items-start gap-2 px-3.5 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 max-w-sm">
                        <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-amber-300">
                            No se pudo aplicar la miniatura personalizada. YouTube va a mostrar un frame propio en su lugar. Detalle: {thumbnailError}
                          </p>
                          <button
                            onClick={retryThumbnail}
                            disabled={retryingThumb}
                            className="mt-1.5 flex items-center gap-1 text-xs text-amber-300 hover:underline disabled:opacity-50"
                          >
                            <RefreshCw className={`w-3 h-3 ${retryingThumb ? "animate-spin" : ""}`} />
                            {retryingThumb ? "Reintentando..." : "Reintentar"}
                          </button>
                        </div>
                      </div>
                    )}
                    <button onClick={reset} className="px-5 py-2 rounded-lg border border-border bg-secondary text-sm text-foreground hover:bg-secondary/80 transition-colors">
                      Publicar otro
                    </button>
                  </motion.div>
                )}

                {/* Detalles */}
                {step === "details" && (
                  <motion.div key="details" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}
                    className="bg-card border border-border rounded-xl p-5 space-y-4">

                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground">Detalles del video</h3>
                      <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">1 / 2</span>
                    </div>

                    {/* Título */}
                    <div className="space-y-1.5">
                      <div className="flex justify-between">
                        <label className="text-xs font-medium text-muted-foreground">Título *</label>
                        <span className={`text-xs font-mono ${title.length > 90 ? "text-amber-400" : "text-muted-foreground"}`}>{title.length}/100</span>
                      </div>
                      <input value={title} onChange={e => setTitle(e.target.value.slice(0, 100))}
                        placeholder="Título del video"
                        className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors" />
                    </div>

                    {/* Descripción */}
                    <div className="space-y-1.5">
                      <div className="flex justify-between">
                        <label className="text-xs font-medium text-muted-foreground">Descripción</label>
                        <span className={`text-xs font-mono ${description.length > 4800 ? "text-amber-400" : "text-muted-foreground"}`}>{description.length}/5000</span>
                      </div>
                      <textarea value={description} onChange={e => setDescription(e.target.value.slice(0, 5000))}
                        placeholder="Describe el video..." rows={4}
                        className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors resize-none" />
                    </div>

                    {/* Tags */}
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" /> Etiquetas</label>
                      <TagInput tags={tags} onChange={setTags} />
                    </div>

                    {/* Categoría */}
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Categoría</label>
                      <select value={categoryId} onChange={e => setCategoryId(e.target.value)}
                        className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary/50 appearance-none cursor-pointer">
                        {YT_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </div>

                    {/* Audiencia — 3 opciones */}
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5" /> Audiencia
                      </label>
                      {([
                        { value: "not_kids",      label: "No está dirigido a niños",     desc: "Contenido general para todo público",              icon: Globe       },
                        { value: "kids",          label: "Está dirigido a niños",         desc: "Contenido diseñado específicamente para menores",  icon: Users       },
                        { value: "age_restricted", label: "Restringir a mayores de 18",  desc: "Contenido solo apto para adultos",                  icon: ShieldAlert },
                      ] as { value: Audience; label: string; desc: string; icon: typeof Globe }[]).map(opt => {
                        const active = audience === opt.value;
                        const Icon = opt.icon;
                        return (
                          <button key={opt.value} type="button" onClick={() => setAudience(opt.value)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                              active ? "border-primary/50 bg-primary/5" : "border-border hover:bg-secondary/50"
                            }`}>
                            <Icon className={`w-4 h-4 flex-shrink-0 ${active ? "text-primary" : "text-muted-foreground"}`} />
                            <div className="flex-1 min-w-0">
                              <p className={`text-xs font-medium ${active ? "text-foreground" : "text-muted-foreground"}`}>{opt.label}</p>
                              <p className="text-[11px] text-muted-foreground/70">{opt.desc}</p>
                            </div>
                            <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${active ? "border-primary" : "border-border"}`}>
                              {active && <div className="w-2 h-2 rounded-full bg-primary" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Miniatura personalizada */}
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <Camera className="w-3.5 h-3.5" /> Miniatura personalizada
                        <span className="ml-auto text-[10px] font-normal opacity-50">opcional</span>
                      </label>

                      {thumbnailPreview ? (
                        <div className="space-y-2">
                          <div className="relative rounded-lg overflow-hidden bg-black flex items-center justify-center" style={{ maxHeight: 120 }}>
                            <img src={thumbnailPreview} alt="miniatura" className="max-h-[120px] max-w-full object-contain" />
                            <button
                              type="button"
                              onClick={() => { setThumbnailBlob(null); setThumbnailPreview(null); }}
                              className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/70 flex items-center justify-center hover:bg-black transition-colors"
                            >
                              <X className="w-3 h-3 text-white" />
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => setShowScrubber(true)}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <RefreshCw className="w-3 h-3" /> Cambiar frame
                          </button>
                        </div>
                      ) : showScrubber && selected ? (
                        <div className="border border-border rounded-xl p-3 space-y-3 bg-secondary/20">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">Desliza el pin para elegir el frame</span>
                            <button type="button" onClick={() => setShowScrubber(false)}>
                              <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                            </button>
                          </div>
                          <ThumbnailScrubber
                            fileId={selected.fileId}
                            onCapture={(blob, preview) => {
                              setThumbnailBlob(blob);
                              setThumbnailPreview(preview);
                              setShowScrubber(false);
                            }}
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => selected && setShowScrubber(true)}
                          disabled={!selected}
                          className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg py-4 text-muted-foreground text-sm hover:border-primary/40 hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Camera className="w-4 h-4" />
                          Elegir frame del video
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}

                {/* Visibilidad */}
                {step === "visibility" && (
                  <motion.div key="visibility" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}
                    className="bg-card border border-border rounded-xl p-5 space-y-4">

                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground">Visibilidad</h3>
                      <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">2 / 2</span>
                    </div>

                    <div className="space-y-2">
                      {PRIVACY_OPTIONS.map(opt => {
                        const active = privacy === opt.value;
                        return (
                          <button key={opt.value} onClick={() => setPrivacy(opt.value)}
                            className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors ${active ? "border-primary/50 bg-primary/5" : "border-border hover:bg-secondary/50"}`}>
                            <opt.Icon className={`w-4 h-4 flex-shrink-0 ${active ? "text-primary" : "text-muted-foreground"}`} />
                            <div className="flex-1">
                              <p className={`text-sm font-medium ${active ? "text-foreground" : "text-muted-foreground"}`}>{opt.label}</p>
                              <p className="text-xs text-muted-foreground">{opt.desc}</p>
                            </div>
                            <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${active ? "border-primary" : "border-border"}`}>
                              {active && <div className="w-2 h-2 rounded-full bg-primary" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Programar */}
                    <div className="border-t border-border pt-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CalendarDays className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm text-foreground">Programar publicación</span>
                      </div>
                      <button onClick={() => setPublishAt(publishAt ? "" : new Date(Date.now() + 86400000).toISOString().slice(0, 16))}
                        className={`relative w-10 h-5 rounded-full transition-colors ${publishAt ? "bg-primary" : "bg-border"}`}>
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${publishAt ? "translate-x-5" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                    {publishAt && (
                      <input type="datetime-local" value={publishAt} onChange={e => setPublishAt(e.target.value)}
                        className="w-full px-3 py-2 bg-secondary/40 border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary/50" />
                    )}

                    {uploadError && (
                      <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                        <p className="text-xs text-red-300">{uploadError}</p>
                      </div>
                    )}
                  </motion.div>
                )}

              </AnimatePresence>

              {/* Footer navegación */}
              {(step === "details" || step === "visibility") && (
                <div className="flex items-center justify-between pt-1">
                  {step === "visibility" ? (
                    <button onClick={() => setStep("details")}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm border border-border bg-secondary text-foreground hover:bg-secondary/80 transition-colors">
                      <ChevronLeft className="w-4 h-4" /> Atrás
                    </button>
                  ) : <div />}

                  {step === "details" ? (
                    <button onClick={() => setStep("visibility")}
                      disabled={!title.trim() || (videoSource === "library" ? !selected : !localFile)}
                      className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      Siguiente <ChevronRight className="w-4 h-4" />
                    </button>
                  ) : (
                    <button onClick={handleUpload}
                      disabled={!connected || (videoSource === "library" ? !selected : !localFile)}
                      className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-sm bg-red-500 hover:bg-red-400 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      <YoutubeIcon className="w-4 h-4" /> Publicar en YouTube
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

        </motion.div>
      </AnimatePresence>

      {/* Modal selector */}
      <AnimatePresence>
        {showPicker && <VideoPickerModal platform={activePlatform} onSelect={v => { setSelected(v); setTitle(v.title.replace(/\.[^.]+$/, "")); }} onClose={() => setShowPicker(false)} />}
      </AnimatePresence>

      {/* Preview del video */}
      {previewVideo && (
        <VideoModal fileId={previewVideo.fileId} title={previewVideo.title} onClose={() => setPreviewVideo(null)} />
      )}
    </div>
  );
}
