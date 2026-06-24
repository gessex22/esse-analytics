import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  SkipBack,
  SkipForward,
} from "lucide-react";

export interface VideoPlayerHandle {
  seekTo: (time: number) => void;
}

interface VideoPlayerProps {
  src: string;
  duration: number;
  onTimeUpdate?: (currentTime: number) => void;
  onReady?: () => void;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayerInner(
  { src, duration, onTimeUpdate, onReady }: VideoPlayerProps,
  ref
) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);

  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered,    setBuffered]     = useState(0);
  const [volume,      setVolume]       = useState(1);
  const [muted,       setMuted]        = useState(false);
  const [speed,       setSpeed]        = useState(1);
  const [showSpeed,   setShowSpeed]    = useState(false);
  const [showControls, setShowControls] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const totalDuration = videoRef.current?.duration || duration || 1;

  // Auto-hide controls
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (playing) setShowControls(false);
    }, 2500);
  }, [playing]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else          { v.pause(); setPlaying(false); setShowControls(true); }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    onTimeUpdate?.(v.currentTime);

    // Buffered progress
    if (v.buffered.length > 0) {
      setBuffered((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    v.currentTime = ratio * v.duration;
  };

  const skip = (secs: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + secs));
  };

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const val = parseFloat(e.target.value);
    v.volume = val;
    setVolume(val);
    setMuted(val === 0);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const setPlaybackSpeed = (s: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = s;
    setSpeed(s);
    setShowSpeed(false);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) wrapRef.current?.requestFullscreen();
    else document.exitFullscreen();
  };

  // Seek from external (transcription click)
  const seekTo = useCallback((time: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = time;
    v.play();
    setPlaying(true);
  }, []);

  // Expose seekTo to parent via ref
  useImperativeHandle(ref, () => ({ seekTo }), [seekTo]);

  const progress = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  return (
    <div
      ref={wrapRef}
      className="relative bg-black rounded-xl overflow-hidden w-full aspect-video group select-none"
      onMouseMove={resetHideTimer}
      onClick={() => { if (!showControls) { resetHideTimer(); } }}
    >
      {/* Video */}
      <video
        ref={videoRef}
        src={src}
        className="w-full h-full object-contain"
        onTimeUpdate={handleTimeUpdate}
        onLoadedData={onReady}
        onEnded={() => { setPlaying(false); setShowControls(true); }}
        onClick={togglePlay}
        preload="metadata"
      />

      {/* Big play/pause overlay */}
      {!playing && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center"
        >
          <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center hover:bg-white/30 transition-colors">
            <Play className="w-7 h-7 text-white fill-white ml-1" />
          </div>
        </button>
      )}

      {/* Controls bar */}
      <div
        className={`absolute bottom-0 left-0 right-0 px-4 pb-3 pt-8 bg-gradient-to-t from-black/80 to-transparent transition-opacity duration-300 ${
          showControls || !playing ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Progress bar */}
        <div
          className="relative w-full h-1.5 rounded-full bg-white/20 cursor-pointer mb-3 group/bar hover:h-2.5 transition-all"
          onClick={handleSeek}
        >
          {/* Buffered */}
          <div
            className="absolute inset-y-0 left-0 bg-white/30 rounded-full"
            style={{ width: `${buffered}%` }}
          />
          {/* Played */}
          <div
            className="absolute inset-y-0 left-0 bg-primary rounded-full"
            style={{ width: `${progress}%` }}
          />
          {/* Thumb */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow opacity-0 group-hover/bar:opacity-100 transition-opacity"
            style={{ left: `calc(${progress}% - 6px)` }}
          />
        </div>

        {/* Buttons row */}
        <div className="flex items-center gap-3">
          {/* Skip back */}
          <button onClick={() => skip(-10)} className="text-white/80 hover:text-white transition-colors" title="−10s">
            <SkipBack className="w-4 h-4" />
          </button>

          {/* Play/Pause */}
          <button onClick={togglePlay} className="text-white hover:text-white/80 transition-colors">
            {playing
              ? <Pause className="w-5 h-5 fill-white" />
              : <Play  className="w-5 h-5 fill-white ml-0.5" />
            }
          </button>

          {/* Skip forward */}
          <button onClick={() => skip(10)} className="text-white/80 hover:text-white transition-colors" title="+10s">
            <SkipForward className="w-4 h-4" />
          </button>

          {/* Time */}
          <span className="text-white/80 text-xs font-mono">
            {formatTime(currentTime)} / {formatTime(totalDuration)}
          </span>

          <div className="flex-1" />

          {/* Volume */}
          <button onClick={toggleMute} className="text-white/80 hover:text-white transition-colors">
            {muted || volume === 0
              ? <VolumeX className="w-4 h-4" />
              : <Volume2 className="w-4 h-4" />
            }
          </button>
          <input
            type="range"
            min="0" max="1" step="0.05"
            value={muted ? 0 : volume}
            onChange={handleVolume}
            className="w-16 accent-primary cursor-pointer"
          />

          {/* Speed */}
          <div className="relative">
            <button
              onClick={() => setShowSpeed(v => !v)}
              className="text-white/80 hover:text-white text-xs font-mono px-1.5 py-0.5 rounded border border-white/20 hover:border-white/50 transition-colors"
            >
              {speed}x
            </button>
            {showSpeed && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowSpeed(false)} />
                <div className="absolute bottom-full right-0 mb-2 bg-card border border-border rounded-lg p-1 z-20 space-y-0.5">
                  {SPEEDS.map(s => (
                    <button
                      key={s}
                      onClick={() => setPlaybackSpeed(s)}
                      className={`w-full px-3 py-1 text-xs rounded text-left transition-colors ${
                        s === speed
                          ? "bg-primary/20 text-primary font-semibold"
                          : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Fullscreen */}
          <button onClick={toggleFullscreen} className="text-white/80 hover:text-white transition-colors">
            <Maximize className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
});
