import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  UploadCloud, Film, Trash2, Camera, X, Loader2, AlertCircle, Play, Link2, Check,
} from "lucide-react";
import { remoteLibraryService, RemoteLibraryVideo, RemoteLibraryPlatformLink, RemotePlatform } from "../services/api";

const PLATFORMS: { key: RemotePlatform; label: string; color: string }[] = [
  { key: "youtube",   label: "YouTube",   color: "text-red-500" },
  { key: "instagram", label: "Instagram", color: "text-pink-500" },
  { key: "tiktok",    label: "TikTok",    color: "text-foreground" },
];

type PlatformState = "publicado" | "descartado" | "pendiente";

function platformState(v: RemoteLibraryVideo, p: RemotePlatform): PlatformState {
  if (v.platforms.includes(p)) return "publicado";
  if (v.platformsDiscarded.includes(p)) return "descartado";
  return "pendiente";
}

const STATE_STYLES: Record<PlatformState, string> = {
  publicado:  "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  descartado: "bg-secondary text-muted-foreground border-border line-through",
  pendiente:  "bg-secondary/60 text-muted-foreground border-border",
};

// Mismos patrones que extractPlatformId en local-backend/src/controllers/
// video.controller.ts (Editar links de plataforma, Videos local) -- si no
// matchea ningún patrón conocido (ej. link acortado vm.tiktok.com), se usa
// la URL completa como platformId: sigue siendo único, solo que Estadísticas
// no podrá pedirle stats a la API real con eso.
function extractPlatformId(platform: RemotePlatform, url: string): string {
  const patterns: Record<RemotePlatform, RegExp> = {
    youtube:   /(?:youtube\.com\/(?:shorts\/|watch\?v=)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/,
    instagram: /instagram\.com\/(?:reel|p|tv)\/([a-zA-Z0-9_-]+)/,
    tiktok:    /tiktok\.com\/@[^/]+\/video\/(\d+)/,
  };
  const match = url.match(patterns[platform]);
  return match ? match[1] : url;
}

// ── Editar links de plataforma de un video de Nube -- mirror de EditLinksModal
// en VideosView.tsx (Videos local), pero contra remoteLibraryService.updatePlatforms
// en vez de videoService.setPlatformLink. platformLinks arranca precargado del
// propio video (ya viene en la respuesta de list()), no hace falta un GET aparte.
function EditRemoteLinksModal({ video, onClose, onSaved }: {
  video: RemoteLibraryVideo;
  onClose: () => void;
  onSaved: (video: RemoteLibraryVideo) => void;
}) {
  const initialLinks = (platform: RemotePlatform) =>
    video.platformLinks?.find(l => l.platform === platform)?.platformUrl ?? "";
  const [links, setLinks] = useState<Record<RemotePlatform, string>>({
    youtube: initialLinks("youtube"),
    instagram: initialLinks("instagram"),
    tiktok: initialLinks("tiktok"),
  });
  const [savingPlatform, setSavingPlatform] = useState<RemotePlatform | null>(null);
  const [errors, setErrors] = useState<Partial<Record<RemotePlatform, string>>>({});
  const [saved, setSaved] = useState<Partial<Record<RemotePlatform, boolean>>>({});

  const handleSave = async (p: RemotePlatform) => {
    const trimmed = links[p].trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      setErrors(e => ({ ...e, [p]: "El link debe empezar con http:// o https://" }));
      return;
    }
    setSavingPlatform(p);
    setErrors(e => ({ ...e, [p]: undefined }));
    try {
      const existing = video.platformLinks?.find(l => l.platform === p);
      const platforms = trimmed
        ? Array.from(new Set([...video.platforms, p]))
        : video.platforms.filter(x => x !== p);
      const platformsDiscarded = video.platformsDiscarded.filter(x => x !== p);
      const link: RemoteLibraryPlatformLink = {
        platform: p,
        platformId: trimmed ? extractPlatformId(p, trimmed) : (existing?.platformId ?? ""),
        platformUrl: trimmed || undefined,
        publishedAt: existing?.publishedAt ?? new Date().toISOString(),
      };
      const updated = await remoteLibraryService.updatePlatforms(video._id, {
        platforms, platformsDiscarded, platformLinks: [link],
      });
      onSaved(updated);
      setSaved(s => ({ ...s, [p]: true }));
      setTimeout(() => setSaved(s => ({ ...s, [p]: false })), 2000);
    } catch (err: any) {
      setErrors(e => ({ ...e, [p]: err.message || "Error al guardar" }));
    } finally {
      setSavingPlatform(null);
    }
  };

  return (
    <motion.div
      key="remote-links-dialog"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-foreground font-semibold text-sm">Editar links de plataforma</h3>
            <p className="text-muted-foreground text-xs mt-1 truncate" title={video.fileName}>{video.fileName}</p>
          </div>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          {PLATFORMS.map(({ key: p, label }) => (
            <div key={p} className="space-y-1">
              <span className="text-xs font-medium text-foreground">{label}</span>
              <div className="flex items-center gap-1.5">
                <input
                  value={links[p]}
                  onChange={(e) => setLinks(prev => ({ ...prev, [p]: e.target.value }))}
                  placeholder="https://..."
                  disabled={savingPlatform === p}
                  className="flex-1 bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary disabled:opacity-50"
                />
                <button
                  onClick={() => handleSave(p)}
                  disabled={savingPlatform !== null}
                  className="flex items-center gap-1 text-xs bg-primary/10 hover:bg-primary/20 text-primary px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex-shrink-0"
                >
                  {savingPlatform === p
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : saved[p] ? <Check className="w-3 h-3" /> : "Guardar"
                  }
                </button>
              </div>
              {errors[p] && <p className="text-[11px] text-red-400">{errors[p]}</p>}
            </div>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

interface UploadTask {
  id: string;
  fileName: string;
  progress: number; // 0..1
  error?: string;
}

const PAGE_SIZE = 10;

export function RemoteLibraryView() {
  const [videos, setVideos]   = useState<RemoteLibraryVideo[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [preview, setPreview] = useState<RemoteLibraryVideo | null>(null);
  const [linksTarget, setLinksTarget] = useState<RemoteLibraryVideo | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fileInputRef  = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);
  const thumbTargetId = useRef<string | null>(null);

  const load = () => {
    setError(null);
    remoteLibraryService.list({ skip: 0, limit: PAGE_SIZE })
      .then(d => { setVideos(d.videos); setHasMore(d.hasMore); })
      .catch(e => setError(e.message || "Error al cargar la biblioteca"));
  };

  const loadMore = () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    remoteLibraryService.list({ skip: videos?.length ?? 0, limit: PAGE_SIZE })
      .then(d => { setVideos(prev => [...(prev ?? []), ...d.videos]); setHasMore(d.hasMore); })
      .catch(e => setError(e.message || "Error al cargar más videos"))
      .finally(() => setLoadingMore(false));
  };

  useEffect(() => { load(); }, []);

  const startUpload = (file: File) => {
    const taskId = `${Date.now()}-${Math.random()}`;
    setUploads(prev => [...prev, { id: taskId, fileName: file.name, progress: 0 }]);

    remoteLibraryService.uploadVideo(file, { fileName: file.name.replace(/\.[^.]+$/, "") }, {
      onProgress: (sent, total) => {
        setUploads(prev => prev.map(u => u.id === taskId ? { ...u, progress: total ? sent / total : 0 } : u));
      },
      onSuccess: (video) => {
        setUploads(prev => prev.filter(u => u.id !== taskId));
        setVideos(prev => [video, ...(prev ?? [])]);
      },
      onError: (err) => {
        setUploads(prev => prev.map(u => u.id === taskId ? { ...u, error: err.message } : u));
      },
    });
  };

  const onPickFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(startUpload);
  };

  const togglePlatform = async (video: RemoteLibraryVideo, p: RemotePlatform) => {
    const current = platformState(video, p);
    const next: PlatformState = current === "pendiente" ? "publicado" : current === "publicado" ? "descartado" : "pendiente";
    const platforms = next === "publicado"
      ? [...video.platforms, p]
      : video.platforms.filter(x => x !== p);
    const platformsDiscarded = next === "descartado"
      ? [...video.platformsDiscarded, p]
      : video.platformsDiscarded.filter(x => x !== p);

    // Optimista -- si falla, se revierte con el error de vuelta al estado anterior.
    setVideos(prev => prev?.map(v => v._id === video._id ? { ...v, platforms, platformsDiscarded } : v) ?? null);
    try {
      await remoteLibraryService.updatePlatforms(video._id, { platforms, platformsDiscarded });
    } catch {
      setVideos(prev => prev?.map(v => v._id === video._id ? video : v) ?? null);
    }
  };

  const deleteVideo = async (id: string) => {
    setDeletingId(id);
    try {
      await remoteLibraryService.remove(id);
      setVideos(prev => prev?.filter(v => v._id !== id) ?? null);
    } catch (e: any) {
      setError(e.message || "No se pudo borrar el video");
    } finally {
      setDeletingId(null);
    }
  };

  const onPickThumbnail = async (file: File | null) => {
    const id = thumbTargetId.current;
    if (!file || !id) return;
    try {
      const video = await remoteLibraryService.uploadThumbnail(id, file);
      setVideos(prev => prev?.map(v => v._id === id ? video : v) ?? null);
    } catch (e: any) {
      setError(e.message || "No se pudo subir la miniatura");
    }
  };

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Biblioteca remota</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Videos guardados en la nube — se suben directo desde acá, sin pasar por tu PC.
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex-shrink-0"
        >
          <UploadCloud className="w-4 h-4" /> Subir video
        </button>
        <input
          ref={fileInputRef} type="file" accept="video/*" multiple className="hidden"
          onChange={e => { onPickFiles(e.target.files); e.target.value = ""; }}
        />
        <input
          ref={thumbInputRef} type="file" accept="image/*" className="hidden"
          onChange={e => { onPickThumbnail(e.target.files?.[0] ?? null); e.target.value = ""; }}
        />
      </div>

      {/* Subidas en curso */}
      <AnimatePresence initial={false}>
        {uploads.map(u => (
          <motion.div
            key={u.id}
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="bg-card border border-border rounded-xl px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-foreground">{u.fileName}</span>
              <span className="text-xs text-muted-foreground flex-shrink-0">
                {u.error ? "Error" : `${Math.round(u.progress * 100)}%`}
              </span>
            </div>
            {u.error ? (
              <p className="text-xs text-red-400 mt-1 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {u.error}
              </p>
            ) : (
              <div className="h-1.5 rounded-full bg-secondary mt-2 overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${u.progress * 100}%` }} />
              </div>
            )}
          </motion.div>
        ))}
      </AnimatePresence>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {/* Grid de videos */}
      {videos === null ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="aspect-video rounded-xl bg-secondary/50 animate-pulse" style={{ opacity: 1 - i * 0.15 }} />
          ))}
        </div>
      ) : videos.length === 0 && uploads.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm border-2 border-dashed border-border rounded-xl">
          Todavía no subiste ningún video a la biblioteca remota.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {videos.map(v => (
            <div key={v._id} className="bg-card border border-border rounded-xl overflow-hidden group">
              <button
                onClick={() => setPreview(v)}
                className="relative w-full aspect-video bg-secondary flex items-center justify-center overflow-hidden"
              >
                {v.thumbnailStoredFileName ? (
                  <img src={remoteLibraryService.thumbnailUrl(v._id)} alt={v.fileName} className="w-full h-full object-cover" />
                ) : (
                  <Film className="w-6 h-6 text-muted-foreground/40" />
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors opacity-0 group-hover:opacity-100">
                  <Play className="w-8 h-8 text-white fill-white" />
                </div>
              </button>

              <div className="p-3 space-y-2">
                <p className="text-sm text-foreground font-medium truncate" title={v.fileName}>{v.fileName}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(v.sizeBytes)}</p>

                <div className="flex items-center gap-1.5 pt-1">
                  {PLATFORMS.map(p => {
                    const state = platformState(v, p.key);
                    return (
                      <button
                        key={p.key}
                        onClick={() => togglePlatform(v, p.key)}
                        title={`${p.label} · ${state}`}
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border transition-colors ${STATE_STYLES[state]}`}
                      >
                        {p.label.slice(0, 2)}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between pt-1 border-t border-border/50 mt-2">
                  <button
                    onClick={() => { thumbTargetId.current = v._id; thumbInputRef.current?.click(); }}
                    title="Cambiar miniatura"
                    className="text-muted-foreground hover:text-foreground transition-colors p-1"
                  >
                    <Camera className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setLinksTarget(v)}
                    title="Editar links de plataforma"
                    className="text-muted-foreground hover:text-primary transition-colors p-1"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => deleteVideo(v._id)}
                    disabled={deletingId === v._id}
                    title="Borrar"
                    className="text-muted-foreground hover:text-red-400 transition-colors p-1 disabled:opacity-40"
                  >
                    {deletingId === v._id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {videos !== null && videos.length > 0 && hasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-secondary text-foreground hover:bg-secondary/70 transition-colors disabled:opacity-50"
          >
            {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {loadingMore ? "Cargando..." : "Cargar más"}
          </button>
        </div>
      )}

      {/* Preview simple */}
      <AnimatePresence>
        {preview && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={e => e.target === e.currentTarget && setPreview(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
              className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden"
            >
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                <h3 className="flex-1 text-sm font-medium text-foreground truncate">{preview.fileName}</h3>
                <button onClick={() => setPreview(null)}>
                  <X className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
              <video src={remoteLibraryService.streamUrl(preview._id)} controls autoPlay className="w-full max-h-[70vh] bg-black" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Editar links de plataforma */}
      <AnimatePresence>
        {linksTarget && (
          <EditRemoteLinksModal
            video={linksTarget}
            onClose={() => setLinksTarget(null)}
            onSaved={(updated) => {
              setVideos(prev => prev?.map(v => v._id === updated._id ? updated : v) ?? null);
              setLinksTarget(updated);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
