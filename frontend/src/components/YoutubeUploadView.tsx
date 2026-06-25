import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  CheckCircle2, ChevronRight, ChevronLeft, Film,
  Search, X, Loader2, Tag, Globe, Lock, Eye,
  CalendarDays, Users, AlertCircle, ExternalLink, RefreshCw, Play, ShieldAlert, Camera,
  UploadCloud, FolderOpen,
} from "lucide-react";

const isRemote = () => {
  const h = window.location.hostname;
  return h !== "localhost" && h !== "127.0.0.1" && !h.startsWith("192.168.");
};
import { videoService, syncService } from "../services/api";
import { VideoModal } from "./player/VideoModal";
import { API_BASE as API } from "../config";

// ── Iconos de plataforma ──────────────────────────────────────────────────────
function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  );
}
function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>
    </svg>
  );
}
function TiktokIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.76a4.85 4.85 0 0 1-1.01-.07z"/>
    </svg>
  );
}

// ── Tipos ─────────────────────────────────────────────────────────────────────
type Platform  = "youtube" | "instagram" | "tiktok";
type SlimVideo = { fileId: string; title: string; duration: string };
type Privacy   = "public" | "unlisted" | "private";
type Step      = "details" | "visibility" | "uploading" | "done";
type Audience  = "not_kids" | "kids" | "age_restricted";

const PLATFORMS: { key: Platform; label: string; color: string; Icon: (p: { className?: string }) => JSX.Element }[] = [
  { key: "youtube",   label: "YouTube",   color: "text-red-500",   Icon: YoutubeIcon   },
  { key: "instagram", label: "Instagram", color: "text-pink-500",  Icon: InstagramIcon },
  { key: "tiktok",    label: "TikTok",    color: "text-foreground", Icon: TiktokIcon   },
];

const YT_CATEGORIES = [
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
function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
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
function VideoPickerModal({ onSelect, onClose }: { onSelect: (v: SlimVideo) => void; onClose: () => void }) {
  const [videos,  setVideos]  = useState<SlimVideo[]>([]);
  const [search,  setSearch]  = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    videoService.getSlimList().then(setVideos).finally(() => setLoading(false));
  }, []);

  const filtered = videos.filter(v => v.title.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && onClose()}>
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg flex flex-col" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center gap-2 p-4 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar video..." className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none" />
          <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground hover:text-foreground" /></button>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : filtered.slice(0, 100).map(v => (
            <button key={v.fileId} onClick={() => { onSelect(v); onClose(); }}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/50 text-left border-b border-border/50 last:border-0">
              <div className="w-16 h-10 rounded bg-secondary flex items-center justify-center flex-shrink-0 relative">
                <Film className="w-3.5 h-3.5 text-muted-foreground/40" />
                {v.duration && <span className="absolute bottom-0.5 right-0.5 text-[9px] bg-black/80 text-white px-1 rounded font-mono">{v.duration}</span>}
              </div>
              <span className="flex-1 text-sm text-foreground truncate">{v.title}</span>
            </button>
          ))}
          {!loading && filtered.length === 0 && <p className="text-center text-muted-foreground text-sm py-8">Sin resultados</p>}
        </div>
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

function TikTokUploadForm({ selected, onChangeVideo }: {
  selected: SlimVideo | null;
  onChangeVideo: () => void;
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

  const recheckTikTok = () => {
    const token = localStorage.getItem("esse_auth_token");
    fetch(`${API}/api/tiktok/auth/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json()).then(d => { setConnected(d.connected); if (d.connected) fetchCreatorInfo(); }).catch(() => {});
  };

  const connectTikTok = async () => {
    const token = localStorage.getItem("esse_auth_token");
    const res = await fetch(`${API}/api/tiktok/auth/url?origin=${encodeURIComponent(window.location.origin)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const { url } = await res.json();
    const w = 600, h = 720;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top  = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(url, "tk_oauth", `width=${w},height=${h},left=${left},top=${top}`);
    const poll = setInterval(() => {
      if (!popup || popup.closed) { clearInterval(poll); recheckTikTok(); }
    }, 500);
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
              <Film className="w-5 h-5 text-muted-foreground/30 group-hover:opacity-0 transition-opacity" />
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
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Cargando cuenta…</div>
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
    <video ref={ref} src={`${API}/api/videos/stream/${fileId}`}
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
        <video ref={videoRef} src={`${API}/api/videos/stream/${fileId}`}
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

// ── Formulario de subida a Instagram ─────────────────────────────────────────
function InstagramUploadForm({ selected, onChangeVideo }: {
  selected: SlimVideo | null;
  onChangeVideo: () => void;
}) {
  const [connected,    setConnected]    = useState<boolean | null>(null);
  const [account,      setAccount]      = useState<{ name: string; username: string; avatarUrl: string } | null>(null);
  const [caption,      setCaption]      = useState("");
  const [tags,         setTags]         = useState<string[]>([]);
  const [thumbOffset,  setThumbOffset]  = useState<number | null>(null);
  const [showScrubber, setShowScrubber] = useState(false);
  const [step,         setStep]         = useState<"details" | "uploading" | "done">("details");
  const [doneUrl,      setDoneUrl]      = useState<string | null>(null);
  const [uploadError,  setUploadError]  = useState<string | null>(null);
  const [previewVideo, setPreviewVideo] = useState<SlimVideo | null>(null);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

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

  const recheckInstagram = () => {
    const token = localStorage.getItem("esse_auth_token");
    fetch(`${API}/api/instagram/auth/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.json()).then(d => { setConnected(d.connected); if (d.connected) fetchAccount(); }).catch(() => {});
  };

  const connectInstagram = async () => {
    const token = localStorage.getItem("esse_auth_token");
    const res = await fetch(`${API}/api/instagram/auth/url?origin=${encodeURIComponent(window.location.origin)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const { url } = await res.json();
    const w = 600, h = 720;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top  = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(url, "ig_oauth", `width=${w},height=${h},left=${left},top=${top}`);
    const poll = setInterval(() => {
      if (!popup || popup.closed) { clearInterval(poll); recheckInstagram(); }
    }, 500);
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
        body: JSON.stringify({ fileId: selected.fileId, caption, tags, thumbOffset }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Error desconocido");
      setDoneUrl(data.postUrl);
      setStep("done");
    } catch (err: any) {
      setUploadError(err.message);
      setStep("details");
    }
  };

  const reset = () => {
    setStep("details");
    setCaption(selected ? selected.title.replace(/\.[^.]+$/, "") : "");
    setTags([]); setThumbOffset(null); setShowScrubber(false);
    setUploadError(null); setDoneUrl(null);
  };

  return (
    <div className="space-y-4">

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
              <Film className="w-5 h-5 text-muted-foreground/30 group-hover:opacity-0 transition-opacity" />
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
          {doneUrl && (
            <a href={doneUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-pink-400 hover:underline">
              Ver en Instagram <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
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

          {uploadError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{uploadError}</p>
            </div>
          )}

          <button onClick={handleUpload} disabled={!connected || !selected || !caption.trim()}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium bg-gradient-to-r from-purple-500 to-pink-500 hover:opacity-90 text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
            <InstagramIcon className="w-4 h-4" /> Publicar Reel
          </button>
        </div>
      )}

      {previewVideo && (
        <VideoModal fileId={previewVideo.fileId} title={previewVideo.title} onClose={() => setPreviewVideo(null)} />
      )}
    </div>
  );
}

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
    canvas.width  = video.videoWidth  || 720;
    canvas.height = video.videoHeight || 1280;
    try {
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (blob) {
          onCapture(blob, canvas.toDataURL("image/jpeg", 0.85));
        }
        setCapturing(false);
      }, "image/jpeg", 0.85);
    } catch {
      setCaptureErr(true);
      setCapturing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg overflow-hidden bg-black flex items-center justify-center" style={{ maxHeight: 200 }}>
        <video
          ref={videoRef}
          src={`${API}/api/videos/stream/${fileId}`}
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
  const [videoSource,     setVideoSource]     = useState<"library" | "device">(() => isRemote() ? "device" : "library");
  const [localFile,       setLocalFile]       = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    syncService.getCalendarConfig()
      .then(configs => {
        const map: Record<Platform, SlimVideo | null> = { youtube: null, instagram: null, tiktok: null };
        for (const c of configs) {
          if (c.nextVideo) map[c.platform as Platform] = c.nextVideo;
        }
        setNextVideos(map);
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
      .then(r => r.ok ? r.json() : null).then(d => d && setChannel(d)).catch(() => {});
  };

  // Al cambiar de plataforma, pre-selecciona su nextVideo
  const switchPlatform = (p: Platform) => {
    setActivePlatform(p);
    setStep("details");
    setUploadError(null);
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

  const handleUpload = async () => {
    setUploadError(null);
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
        if (thumbnailBlob && data.videoId) {
          try {
            const base64 = await new Promise<string>(resolve => {
              const reader = new FileReader();
              reader.onload = e => resolve(e.target?.result as string);
              reader.readAsDataURL(thumbnailBlob);
            });
            await fetch(`${API}/api/youtube/thumbnail/${data.videoId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeader },
              body: JSON.stringify({ imageBase64: base64 }),
            });
          } catch { /* no bloquea el flujo */ }
        }
      }

      setDoneUrl(data.videoUrl);
      setStep("done");
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
    setUploadError(null); setDoneUrl(null);
    setThumbnailBlob(null); setThumbnailPreview(null); setShowScrubber(false);
    setLocalFile(null);
  };

  const plat = PLATFORMS.find(p => p.key === activePlatform)!;

  return (
    <div className="space-y-5 max-w-4xl mx-auto">

      {/* ── Tabs de plataforma ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 bg-card border border-border rounded-xl p-1.5">
        {PLATFORMS.map(p => {
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

      {/* ── Contenido por plataforma ──────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        <motion.div key={activePlatform} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>

          {/* Instagram */}
          {activePlatform === "instagram" && (
            <InstagramUploadForm
              selected={selected}
              onChangeVideo={() => setShowPicker(true)}
            />
          )}

          {/* TikTok */}
          {activePlatform === "tiktok" && (
            <TikTokUploadForm
              selected={selected}
              onChangeVideo={() => setShowPicker(true)}
            />
          )}

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
                          <Film className="w-5 h-5 text-muted-foreground/30 group-hover:opacity-0 transition-opacity" />
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
        {showPicker && <VideoPickerModal onSelect={v => { setSelected(v); setTitle(v.title.replace(/\.[^.]+$/, "")); }} onClose={() => setShowPicker(false)} />}
      </AnimatePresence>

      {/* Preview del video */}
      {previewVideo && (
        <VideoModal fileId={previewVideo.fileId} title={previewVideo.title} onClose={() => setPreviewVideo(null)} />
      )}
    </div>
  );
}
