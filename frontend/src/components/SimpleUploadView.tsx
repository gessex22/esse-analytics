import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Film, Play, Loader2, CheckCircle2, AlertCircle, ChevronDown, RefreshCw,
  ExternalLink, Globe, Users, Tag, Wrench,
} from "lucide-react";
import { videoService, syncService, setupService } from "../services/api";
import { VideoModal } from "./player/VideoModal";
import { Skeleton } from "./ui/skeleton";
import {
  Platform, SlimVideo, PLATFORMS, YT_CATEGORIES,
  TagInput, VideoPickerModal, AccountCardSkeleton, resolveNextForPlatform,
} from "./YoutubeUploadView";
import { API_BASE as API } from "../config";

type TkPrivacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
const TK_PRIVACY_LABELS: Record<TkPrivacy, string> = {
  PUBLIC_TO_EVERYONE:    "Público",
  MUTUAL_FOLLOW_FRIENDS: "Amigos mutuos",
  FOLLOWER_OF_CREATOR:   "Seguidores",
  SELF_ONLY:             "Solo yo",
};

type ConnStatus = boolean | null;
type ResultStatus = "idle" | "uploading" | "success" | "error";
interface UploadResult { status: ResultStatus; message?: string; url?: string; note?: string; }

const IDLE_RESULTS: Record<Platform, UploadResult> = {
  youtube: { status: "idle" }, instagram: { status: "idle" }, tiktok: { status: "idle" },
};

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("esse_auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const ENDPOINTS: Record<Platform, string> = {
  youtube: "/api/youtube/upload", instagram: "/api/instagram/upload", tiktok: "/api/tiktok/upload",
};

export function SimpleUploadView({ onManualMode }: { onManualMode: () => void }) {
  const [loadingNext, setLoadingNext] = useState(true);
  const [video, setVideo]             = useState<SlimVideo | null>(null);
  const [showPicker, setShowPicker]   = useState(false);
  const [previewVideo, setPreviewVideo] = useState<SlimVideo | null>(null);

  const [conn,    setConn]    = useState<Record<Platform, ConnStatus>>({ youtube: null, instagram: null, tiktok: null });
  const [checked, setChecked] = useState<Record<Platform, boolean>>({ youtube: false, instagram: false, tiktok: false });
  const [expanded, setExpanded] = useState<Record<Platform, boolean>>({ youtube: false, instagram: false, tiktok: false });
  // Plataformas que el usuario eligió usar (Ajustes > Cuentas) — las demás no
  // aparecen en esta lista aunque estén conectadas.
  const [visiblePlatforms, setVisiblePlatforms] = useState<Platform[]>(["youtube", "instagram", "tiktok"]);
  useEffect(() => {
    setupService.getActivePlatforms().then(d => {
      if (d.activePlatforms.length) setVisiblePlatforms(d.activePlatforms);
    }).catch(() => {});
  }, []);

  const [title, setTitle]             = useState("");
  const [description, setDescription] = useState("");

  // YouTube
  const [ytCategory, setYtCategory] = useState("24");
  const [ytAudience, setYtAudience] = useState<"not_kids" | "kids" | "age_restricted">("not_kids");
  const [ytPrivacy,  setYtPrivacy]  = useState<"public" | "unlisted" | "private">("public");

  // Instagram
  const [igTags,         setIgTags]         = useState<string[]>([]);
  const [igCrossPostFb,  setIgCrossPostFb]  = useState(false);

  // TikTok
  const [tkPrivacyOptions, setTkPrivacyOptions] = useState<TkPrivacy[]>([]);
  const [tkPrivacy,        setTkPrivacy]        = useState<TkPrivacy | "">("");
  const [tkAllowComment,   setTkAllowComment]   = useState(false);
  const [tkAllowDuet,      setTkAllowDuet]      = useState(false);
  const [tkAllowStitch,    setTkAllowStitch]    = useState(false);
  const [tkCommercial,     setTkCommercial]     = useState(false);
  const [tkBrandOrganic,   setTkBrandOrganic]   = useState(false);
  const [tkBrandedContent, setTkBrandedContent] = useState(false);

  const [publishing, setPublishing] = useState(false);
  const [results, setResults]       = useState<Record<Platform, UploadResult>>(IDLE_RESULTS);
  // Plataforma de referencia para numerar la cola en el buscador de video — en
  // modo simple las 3 colas deberían coincidir, así que cualquiera sirve.
  const [queuePlatform, setQueuePlatform] = useState<Platform>("youtube");

  const loadNextVideo = () => {
    setLoadingNext(true);
    return Promise.all([syncService.getCalendarConfig(), videoService.getSlimList().catch(() => [] as SlimVideo[])])
      .then(([configs, slim]) => {
        // En modo simple las 3 colas deberían coincidir (avanzan siempre juntas) —
        // se toma la plataforma que de verdad avanzó última como la canónica,
        // mismo criterio que usa el Calendario para colapsar a una sola tarjeta.
        const canonical = [...configs]
          .filter(c => c.lastPublishedDate)
          .sort((a, b) => (b.lastPublishedDate || "").localeCompare(a.lastPublishedDate || ""))[0]?.platform as Platform | undefined;
        const platform = canonical ?? "youtube";
        setQueuePlatform(platform);
        const cfg = configs.find(c => c.platform === platform);
        const next = resolveNextForPlatform(slim, cfg?.nextVideoId, platform);
        setVideo(next);
        setTitle(next ? next.title.replace(/\.[^.]+$/, "") : "");
        setDescription("");
      })
      .finally(() => setLoadingNext(false));
  };

  const checkStatus = (p: Platform) => {
    fetch(`${API}/api/${p}/auth/status`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        setConn(prev => ({ ...prev, [p]: !!d.connected }));
        setChecked(prev => ({ ...prev, [p]: !!d.connected }));
      })
      .catch(() => setConn(prev => ({ ...prev, [p]: false })));
  };

  useEffect(() => {
    loadNextVideo();
    (["youtube", "instagram", "tiktok"] as Platform[]).forEach(checkStatus);

    fetch(`${API}/api/tiktok/creator-info`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setTkPrivacyOptions(d.privacyOptions ?? []))
      .catch(() => {});

    const onMsg = (e: MessageEvent) => {
      if (e.data?.source === "instagram_auth" && e.data.status === "success") checkStatus("instagram");
      if (e.data?.source === "tiktok_auth" && e.data.status === "success") checkStatus("tiktok");
    };
    window.addEventListener("message", onMsg);

    const params = new URLSearchParams(window.location.search);
    if (params.get("youtube_auth") === "success" || params.get("instagram_auth") === "success" || params.get("tiktok_auth") === "success") {
      (["youtube", "instagram", "tiktok"] as Platform[]).forEach(checkStatus);
      window.history.replaceState({}, "", window.location.pathname);
    }

    return () => window.removeEventListener("message", onMsg);
  }, []);

  const connectPopup = async (p: Platform) => {
    const res = await fetch(`${API}/api/${p}/auth/url?origin=${encodeURIComponent(window.location.origin)}`, { headers: authHeaders() });
    const { url } = await res.json();
    if (p === "youtube") { window.location.href = url; return; }
    const w = 600, h = 720;
    const left = window.screenX + (window.outerWidth - w) / 2;
    const top  = window.screenY + (window.outerHeight - h) / 2;
    const popup = window.open(url, `${p}_oauth`, `width=${w},height=${h},left=${left},top=${top}`);
    if (popup) {
      const poll = setInterval(() => { if (popup.closed) { clearInterval(poll); checkStatus(p); } }, 500);
    } else {
      // En Electron, setWindowOpenHandler intercepta window.open y lo abre en el
      // navegador externo (shell.openExternal) — no hay ventana ni window.opener
      // para detectar el cierre ni recibir el postMessage. Reintentamos el
      // status en el fondo hasta que conecte o se agote el tiempo.
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        checkStatus(p);
        if (attempts >= 40) clearInterval(poll);
      }, 3000);
    }
  };

  const toggleChecked = (p: Platform) => {
    if (!conn[p]) return;
    setChecked(prev => ({ ...prev, [p]: !prev[p] }));
  };

  const buildPayload = (p: Platform): any => {
    const baseTitle = title.trim() || "Sin título";
    if (p === "youtube") {
      return {
        fileId: video!.fileId, title: baseTitle.slice(0, 100), description,
        categoryId: ytCategory, privacyStatus: ytPrivacy,
        madeForKids: ytAudience === "kids", ageRestricted: ytAudience === "age_restricted",
      };
    }
    if (p === "instagram") {
      const caption = description.trim() ? `${baseTitle}\n\n${description}` : baseTitle;
      return { fileId: video!.fileId, caption: caption.slice(0, 2200), tags: igTags, crossPostFacebook: igCrossPostFb };
    }
    return {
      fileId: video!.fileId, title: baseTitle.slice(0, 2200), privacyLevel: tkPrivacy,
      disableComment: !tkAllowComment, disableDuet: !tkAllowDuet, disableStitch: !tkAllowStitch,
      brandOrganic: tkCommercial && tkBrandOrganic, brandedContent: tkCommercial && tkBrandedContent,
    };
  };

  // visiblePlatforms también filtra acá, no solo en el render: si el usuario
  // desactivó una plataforma pero ya estaba conectada, checked[p] igual se
  // había puesto en true en checkStatus — sin este filtro se publicaría ahí
  // aunque la fila esté oculta.
  const platformsToSubmit = (["youtube", "instagram", "tiktok"] as Platform[]).filter(p => checked[p] && conn[p] && visiblePlatforms.includes(p));
  const missingTkPrivacy = visiblePlatforms.includes("tiktok") && checked.tiktok && conn.tiktok && !tkPrivacy;

  const uploadOne = async (p: Platform) => {
    setResults(prev => ({ ...prev, [p]: { status: "uploading" } }));
    try {
      const res = await fetch(`${API}${ENDPOINTS[p]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(buildPayload(p)),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Error desconocido");
      // Instagram con cross-post: reportar el resultado REAL de Facebook (antes
      // el checkbox no hacía nada y el éxito era silencioso/falso).
      const note = p === "instagram" && igCrossPostFb
        ? (data.facebookUrl ? undefined : `Facebook no salió: ${data.facebookError ?? "error desconocido"}`)
        : undefined;
      setResults(prev => ({ ...prev, [p]: { status: "success", url: data.videoUrl || data.postUrl, note } }));
    } catch (err: any) {
      setResults(prev => ({ ...prev, [p]: { status: "error", message: err.message } }));
    }
  };

  const handlePublish = async () => {
    if (!video || publishing || platformsToSubmit.length === 0) return;
    if (missingTkPrivacy) { setExpanded(prev => ({ ...prev, tiktok: true })); return; }

    setPublishing(true);
    setResults(IDLE_RESULTS);
    for (const p of platformsToSubmit) {
      // eslint-disable-next-line no-await-in-loop
      await uploadOne(p);
    }
    setPublishing(false);
    loadNextVideo();
  };

  const allDone = platformsToSubmit.length > 0 && platformsToSubmit.every(p => results[p].status === "success" || results[p].status === "error");

  return (
    <div className="space-y-5 max-w-2xl mx-auto">

      {/* ── Video a publicar ──────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Video a publicar</span>
          <button onClick={() => setShowPicker(true)} className="flex items-center gap-1.5 text-xs text-primary hover:underline">
            <RefreshCw className="w-3 h-3" /> Cambiar video
          </button>
        </div>
        {loadingNext ? (
          <div className="flex items-center gap-3">
            <Skeleton className="w-24 h-14 rounded-lg flex-shrink-0" />
            <Skeleton className="h-4 w-40 rounded" />
          </div>
        ) : video ? (
          <div className="flex items-center gap-3">
            <button onClick={() => setPreviewVideo(video)}
              className="w-24 h-14 rounded-lg bg-secondary border border-border flex items-center justify-center flex-shrink-0 relative group hover:border-primary/50 transition-colors">
              <Film className="w-5 h-5 text-muted-foreground/30 group-hover:opacity-0 transition-opacity" />
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="w-8 h-8 rounded-full bg-black/70 flex items-center justify-center">
                  <Play className="w-4 h-4 text-white fill-white ml-0.5" />
                </div>
              </div>
              {video.duration && <span className="absolute bottom-1 right-1 text-[9px] bg-black/80 text-white px-1 rounded font-mono">{video.duration}</span>}
            </button>
            <p className="text-sm text-foreground font-medium truncate">{video.title}</p>
          </div>
        ) : (
          <button onClick={() => setShowPicker(true)}
            className="w-full border-2 border-dashed border-border rounded-lg py-6 text-muted-foreground text-sm hover:border-primary/40 hover:text-foreground transition-colors">
            No hay próximo video — elegí uno
          </button>
        )}
      </div>

      {/* ── Título y descripción compartidos ──────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Título</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Título del video…"
            className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Descripción</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
            placeholder="Opcional — se usa en YouTube y se agrega al caption de Instagram"
            className="w-full px-3 py-2.5 bg-secondary/40 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 transition-colors resize-none" />
        </div>
      </div>

      {/* ── Plataformas ────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        {PLATFORMS.filter(({ key }) => visiblePlatforms.includes(key)).map(({ key: p, label, color, Icon }) => {
          const status = conn[p];
          const result = results[p];
          return (
            <div key={p} className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                {status === null ? (
                  <div className="flex-1"><AccountCardSkeleton /></div>
                ) : status === false ? (
                  <>
                    <Icon className={`w-4 h-4 ${color} opacity-40 flex-shrink-0`} />
                    <span className="flex-1 text-sm text-muted-foreground">{label} — no conectado</span>
                    <button onClick={() => connectPopup(p)}
                      className="text-xs bg-secondary border border-border px-3 py-1.5 rounded-full hover:bg-secondary/80 transition-colors flex-shrink-0">
                      Conectar
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => toggleChecked(p)}
                      className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                        checked[p] ? "bg-primary border-primary" : "border-border hover:border-primary/60"
                      }`}>
                      {checked[p] && <CheckCircle2 className="w-3.5 h-3.5 text-primary-foreground" />}
                    </button>
                    <Icon className={`w-4 h-4 ${color} flex-shrink-0`} />
                    <span className="flex-1 text-sm text-foreground font-medium">{label}</span>

                    {result.status === "uploading" && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground flex-shrink-0" />}
                    {result.status === "success" && (
                      <span className="flex items-center gap-1 text-xs text-emerald-400 flex-shrink-0">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Publicado
                        {result.url && <a href={result.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="w-3 h-3" /></a>}
                      </span>
                    )}
                    {result.status === "error" && (
                      <button onClick={() => uploadOne(p)} className="flex items-center gap-1 text-xs text-red-400 hover:underline flex-shrink-0">
                        <AlertCircle className="w-3.5 h-3.5" /> Reintentar
                      </button>
                    )}

                    {checked[p] && result.status === "idle" && (
                      <button onClick={() => setExpanded(prev => ({ ...prev, [p]: !prev[p] }))}
                        className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
                        <ChevronDown className={`w-4 h-4 transition-transform ${expanded[p] ? "rotate-180" : ""}`} />
                      </button>
                    )}
                  </>
                )}
              </div>

              {result.status === "error" && result.message && (
                <p className="px-4 pb-3 text-xs text-red-300">{result.message}</p>
              )}
              {result.status === "success" && result.note && (
                <p className="px-4 pb-3 text-xs text-amber-300">{result.note}</p>
              )}

              <AnimatePresence initial={false}>
                {status === true && checked[p] && expanded[p] && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }} style={{ overflow: "hidden" }}>
                    <div className="px-4 pb-4 pt-1 border-t border-border/60 space-y-3">
                      {p === "youtube" && (
                        <>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">Categoría</label>
                            <select value={ytCategory} onChange={e => setYtCategory(e.target.value)}
                              className="w-full px-3 py-2 bg-secondary/40 border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary/50">
                              {YT_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                            </select>
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Users className="w-3 h-3" /> Audiencia</label>
                            <select value={ytAudience} onChange={e => setYtAudience(e.target.value as any)}
                              className="w-full px-3 py-2 bg-secondary/40 border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary/50">
                              <option value="not_kids">No es contenido para niños</option>
                              <option value="kids">Es contenido para niños</option>
                              <option value="age_restricted">Restringido por edad</option>
                            </select>
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Globe className="w-3 h-3" /> Privacidad</label>
                            <select value={ytPrivacy} onChange={e => setYtPrivacy(e.target.value as any)}
                              className="w-full px-3 py-2 bg-secondary/40 border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary/50">
                              <option value="public">Público</option>
                              <option value="unlisted">No listado</option>
                              <option value="private">Privado</option>
                            </select>
                          </div>
                        </>
                      )}

                      {p === "instagram" && (
                        <>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" /> Hashtags</label>
                            <TagInput tags={igTags} onChange={setIgTags} />
                          </div>
                          <label className="flex items-center gap-3 cursor-pointer select-none">
                            <input type="checkbox" checked={igCrossPostFb} onChange={e => setIgCrossPostFb(e.target.checked)} className="accent-primary" />
                            <span className="text-sm text-muted-foreground">
                              También publicar en Facebook
                              <span className="block text-[11px] text-muted-foreground/70">
                                Se publica aparte en tu Página de Facebook vinculada — no depende de ninguna config de Instagram
                              </span>
                            </span>
                          </label>
                        </>
                      )}

                      {p === "tiktok" && (
                        <>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1"><Globe className="w-3 h-3" /> Quién puede ver este video *</label>
                            <select value={tkPrivacy} onChange={e => setTkPrivacy(e.target.value as TkPrivacy)}
                              className="w-full px-3 py-2 bg-secondary/40 border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary/50">
                              <option value="" disabled>Selecciona una opción…</option>
                              {tkPrivacyOptions.map(v => <option key={v} value={v}>{TK_PRIVACY_LABELS[v]}</option>)}
                            </select>
                            {missingTkPrivacy && <p className="text-[11px] text-amber-400">TikTok exige elegir quién puede ver el video.</p>}
                          </div>
                          <div className="flex flex-wrap gap-4">
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                              <input type="checkbox" checked={tkAllowComment} onChange={e => setTkAllowComment(e.target.checked)} className="accent-primary" />
                              <span className="text-xs text-muted-foreground">Comentarios</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                              <input type="checkbox" checked={tkAllowDuet} onChange={e => setTkAllowDuet(e.target.checked)} className="accent-primary" />
                              <span className="text-xs text-muted-foreground">Dueto</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                              <input type="checkbox" checked={tkAllowStitch} onChange={e => setTkAllowStitch(e.target.checked)} className="accent-primary" />
                              <span className="text-xs text-muted-foreground">Stitch</span>
                            </label>
                          </div>
                          <label className="flex items-center gap-3 cursor-pointer select-none">
                            <input type="checkbox" checked={tkCommercial}
                              onChange={e => { const v = e.target.checked; setTkCommercial(v); if (!v) { setTkBrandOrganic(false); setTkBrandedContent(false); } }}
                              className="accent-primary" />
                            <span className="text-sm text-muted-foreground">Divulgar contenido comercial</span>
                          </label>
                          {tkCommercial && (
                            <div className="flex flex-wrap gap-4 pl-1">
                              <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input type="checkbox" checked={tkBrandOrganic} onChange={e => setTkBrandOrganic(e.target.checked)} className="accent-primary" />
                                <span className="text-xs text-muted-foreground">Tu marca</span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input type="checkbox" checked={tkBrandedContent} onChange={e => setTkBrandedContent(e.target.checked)} className="accent-primary" />
                                <span className="text-xs text-muted-foreground">Contenido de marca</span>
                              </label>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* ── Publicar ───────────────────────────────────────────────────────── */}
      <button onClick={handlePublish} disabled={!video || publishing || platformsToSubmit.length === 0}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
        {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        {publishing
          ? "Publicando…"
          : platformsToSubmit.length > 0
            ? `Publicar en ${platformsToSubmit.length} plataforma${platformsToSubmit.length === 1 ? "" : "s"}`
            : "Elegí al menos una plataforma"}
      </button>

      {allDone && (
        <button onClick={() => setResults(IDLE_RESULTS)}
          className="w-full py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground transition-colors">
          Listo — publicar otro
        </button>
      )}

      <button onClick={onManualMode} className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
        <Wrench className="w-3.5 h-3.5" /> Subida manual (avanzada) para casos especiales
      </button>

      {showPicker && (
        <VideoPickerModal
          platform={queuePlatform}
          onSelect={v => { setVideo(v); setTitle(v.title.replace(/\.[^.]+$/, "")); }}
          onClose={() => setShowPicker(false)}
        />
      )}
      {previewVideo && (
        <VideoModal fileId={previewVideo.fileId} title={previewVideo.title} onClose={() => setPreviewVideo(null)} />
      )}
    </div>
  );
}
