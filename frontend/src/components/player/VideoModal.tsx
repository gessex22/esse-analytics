import { useEffect, useRef, useState, useCallback } from "react";
import { motion } from "motion/react";
import { X, FileVideo, Download } from "lucide-react";
import { videoService, VideoPlayerData } from "../../services/api";
import { VideoPlayer, VideoPlayerHandle } from "./VideoPlayer";
import { ScriptPanel } from "./ScriptPanel";
import { TranscriptionPanel } from "./TranscriptionPanel";
import { API_BASE } from "../../config";

const API_BASE_URL = API_BASE;

interface VideoModalProps {
  fileId: string;
  title: string;
  onClose: () => void;
}

type TabId = "script" | "transcription";

export function VideoModal({ fileId, title, onClose }: VideoModalProps) {
  const [data, setData]         = useState<VideoPlayerData | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeTab, setActiveTab]     = useState<TabId>("script");

  // Ref para seek desde TranscriptionPanel → VideoPlayer
  const playerRef = useRef<VideoPlayerHandle>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    videoService
      .getVideoPlayerData(fileId)
      .then(setData)
      .catch((e) => setError(e.message || "Error al cargar datos del video"))
      .finally(() => setLoading(false));
  }, [fileId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSeek = useCallback((time: number) => {
    playerRef.current?.seekTo(time);
  }, []);

  const streamUrl   = `${API_BASE_URL}/api/videos/stream/${fileId}`;
  const downloadUrl = `${API_BASE_URL}/api/videos/download/${fileId}`;
  const duration  = data?.file?.duration_seconds ?? 0;
  const wpm       = data?.transcript?.palabras_por_minuto ?? 150;

  return (
    /* Backdrop */
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Modal shell */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
        className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-7xl max-h-[92vh] flex flex-col overflow-hidden"
      >

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border flex-shrink-0">
          <FileVideo className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <h2 className="flex-1 text-sm font-medium text-foreground truncate">{title}</h2>
          <a
            href={downloadUrl}
            title="Descargar video"
            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
          >
            <Download className="w-4 h-4" />
          </a>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Cargando…
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-destructive text-sm">
            {error}
          </div>
        ) : (
          /* Una sola instancia de VideoPlayer — evita el bug de dos refs */
          <div className="flex flex-col flex-1 min-h-0 p-4 gap-4">

            {/* Video (siempre visible arriba en mobile; izquierda en desktop vía flex-row) */}
            <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0">

              {/* ── Columna izquierda: player ── */}
              <div className="flex flex-col gap-3 lg:w-[30%] flex-shrink-0">
                <VideoPlayer
                  ref={playerRef}
                  src={streamUrl}
                  duration={duration}
                  onTimeUpdate={setCurrentTime}
                />
                {data?.file && (
                  <div className="text-[11px] text-muted-foreground space-y-0.5 px-1">
                    <div><span className="font-medium">Formato:</span> {data.file.formato}</div>
                    {data.file.resolucion && (
                      <div><span className="font-medium">Resolución:</span> {data.file.resolucion}</div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Paneles: columnas en desktop, tabs en mobile ── */}

              {/* Desktop: guión + transcripción en columnas */}
              <div className="hidden lg:flex flex-1 min-h-0 gap-0">
                <div className="flex flex-col w-[35%] min-h-0 border-l border-border pl-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex-shrink-0">
                    Guión
                  </h3>
                  <ScriptPanel
                    ideaNucleo={data?.script?.idea_nucleo ?? ""}
                    resumenVisual={data?.script?.resumen_visual ?? ""}
                  />
                </div>
                <div className="flex flex-col flex-1 min-h-0 border-l border-border pl-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex-shrink-0">
                    Transcripción
                  </h3>
                  <TranscriptionPanel
                    text={data?.transcript?.transcript_text ?? ""}
                    duration={duration}
                    wordsPerMinute={wpm}
                    currentTime={currentTime}
                    onSeek={handleSeek}
                  />
                </div>
              </div>

              {/* Mobile: tabs */}
              <div className="flex lg:hidden flex-col flex-1 min-h-0">
                <div className="flex border-b border-border flex-shrink-0">
                  {(["script", "transcription"] as TabId[]).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                        activeTab === tab
                          ? "border-primary text-primary"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {tab === "script" ? "Guión" : "Transcripción"}
                    </button>
                  ))}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto pt-3">
                  {activeTab === "script" ? (
                    <ScriptPanel
                      ideaNucleo={data?.script?.idea_nucleo ?? ""}
                      resumenVisual={data?.script?.resumen_visual ?? ""}
                    />
                  ) : (
                    <TranscriptionPanel
                      text={data?.transcript?.transcript_text ?? ""}
                      duration={duration}
                      wordsPerMinute={wpm}
                      currentTime={currentTime}
                      onSeek={handleSeek}
                    />
                  )}
                </div>
              </div>

            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
