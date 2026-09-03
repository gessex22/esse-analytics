import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import {
  Play, Camera, Music2, Clock, Pencil,
  ChevronLeft, ChevronRight, Pin, Loader2, Check, Clapperboard, RefreshCw,
  Eye, Heart, MessageCircle, Send, SkipForward,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { videoService, syncService, setupService, WorkflowMode } from "../services/api";

type SlimVideo = { fileId: string; title: string; duration: string; platforms: string[]; platforms_discarded: string[] };
import {
  Platform, PlatformSlot, calcNextDate, FALLBACK_SLOTS,
} from "../data/mockPublishingData";

// ── Config ────────────────────────────────────────────────────────────────────

const PLATFORM_CFG = {
  tiktok:    { label: "TikTok",    icon: Music2,  bg: "bg-pink-500",   grad: "from-pink-500 to-rose-600",      text: "text-pink-500",   light: "bg-pink-500/10"   },
  instagram: { label: "Instagram", icon: Camera,  bg: "bg-purple-500", grad: "from-purple-500 to-fuchsia-600", text: "text-purple-500", light: "bg-purple-500/10" },
  youtube:   { label: "YouTube",   icon: Play,    bg: "bg-red-500",    grad: "from-red-500 to-red-700",        text: "text-red-500",    light: "bg-red-500/10"    },
} as const;

// Flujo simple: la tarjeta de "próxima publicación" va a las 3 plataformas por
// igual, así que no tiene sentido pintarla con la marca de una sola (por defecto
// terminaba siempre en YouTube). Un estilo neutro deja claro que no es "la de YouTube".
const NEUTRAL_CFG = { label: "Próxima publicación", icon: Send, bg: "bg-primary", grad: "from-primary to-primary/70", text: "text-primary", light: "bg-primary/10" } as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Urgency = "today" | "soon" | "ok";

function relDays(next: string): number {
  const t = todayStr();
  return Math.round(
    (new Date(next + "T00:00:00").getTime() - new Date(t + "T00:00:00").getTime()) / 86400000
  );
}

// Decisión del usuario 2026-08-30: un pendiente vencido (d < 0, todavía sin
// publicar) ya NO es un bucket "past" propio -- se trata idéntico a "today"
// (mismo color, mismo label "Hoy", sin contador de días vencidos) hasta que
// se publique de verdad, lo que recalcula nextDate hacia adelante. Antes
// tenía su propia urgencia "past" (rojo, ícono de alerta, sección "Vencido"
// separada); mismo criterio reemplazado en paralelo en CalendarView.swift
// (iOS) y CalendarScreen.kt (Android).
function getUrgency(next: string): Urgency {
  const d = relDays(next);
  if (d <= 0) return "today";
  return d <= 1 ? "soon" : "ok";
}

// Texto relativo corto: "Hoy", "Mañana", "en 3 días".
function urgencyLabel(next: string): string {
  const d = relDays(next);
  if (d <= 0) return "Hoy";
  if (d === 1) return "Mañana";
  return `en ${d} días`;
}

// Texto del diseño clásico (PC): "Hoy", "En N días".
function daysLabel(next: string): string {
  const d = relDays(next);
  if (d <= 0) return "Hoy";
  return `En ${d} día${d !== 1 ? "s" : ""}`;
}

function formatShortDate(s: string) {
  if (!s) return "—";
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es", { day: "numeric", month: "short" });
}

function formatDate(s: string) {
  if (!s) return "—";
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
}

function formatLongDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
}

function formatPublishedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const URG_TEXT: Record<Urgency, string> = {
  today: "text-orange-500",
  soon:  "text-amber-500",
  ok:    "text-emerald-500",
};

// ── Types ─────────────────────────────────────────────────────────────────────

type PublishedVideo = {
  platform:    Platform;
  fileName:    string | null;
  fileId:      string | null;
  platformId:  string | null;
  platformUrl: string | null;
  publishedAt: string | null;
  title?:      string | null;
  status?:     string | null;
  stats?:      Record<string, any>;
};

// ── Inline interval editor (mobile) ─────────────────────────────────────────────

function IntervalChip({ days, onChange }: { days: number; onChange: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(days));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  useEffect(() => { setVal(String(days)); }, [days]);

  function commit() {
    const n = parseInt(val, 10);
    if (Number.isFinite(n) && n >= 1) onChange(n);
    else setVal(String(days));
    setEditing(false);
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-foreground">
        cada
        <input
          ref={inputRef}
          type="number"
          min={1}
          max={60}
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          className="w-6 text-center bg-transparent focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        d
      </span>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      title="Editar intervalo"
      className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground hover:text-foreground transition-colors"
    >
      cada {days}d
    </button>
  );
}

// ── Stats chips (mobile history) ─────────────────────────────────────────────

// Vistas/likes/comentarios con ícono en vez de etiqueta de texto (ahorra espacio);
// "--" cuando la plataforma no expone ese dato, en vez de ocultar el chip.
type StatChip = { Icon: LucideIcon; v: string };

function getStatChips(stats: Record<string, any> | undefined, platform: Platform | undefined): StatChip[] {
  const n = (v: any) => Number.isFinite(+v) ? (+v).toLocaleString() : "—";
  const has = (v: any) => v != null && v !== "";
  const val = (v: any) => has(v) ? n(v) : "--";
  const s = stats ?? {};
  if (platform === "youtube")   return [
    { Icon: Eye, v: val(s.viewCount) }, { Icon: Heart, v: val(s.likeCount) }, { Icon: MessageCircle, v: val(s.commentCount) },
  ];
  if (platform === "instagram") return [
    { Icon: Eye, v: val(s.views) }, { Icon: Heart, v: val(s.like_count) }, { Icon: MessageCircle, v: val(s.comments_count) },
  ];
  if (platform === "tiktok") return [
    { Icon: Eye, v: val(s.views) }, { Icon: Heart, v: val(s.likes) }, { Icon: MessageCircle, v: val(s.comments) },
  ];
  return [{ Icon: Eye, v: "--" }, { Icon: Heart, v: "--" }, { Icon: MessageCircle, v: "--" }];
}

// Vistas como número (para sumarlas entre plataformas en el modo simple).
function getViewsCount(stats: Record<string, any> | undefined, platform: Platform | undefined): number {
  const s = stats ?? {};
  const raw = platform === "youtube" ? s.viewCount : s.views;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// MOBILE — feed por urgencia (fila compacta)
// ══════════════════════════════════════════════════════════════════════════════

function UpcomingCard({
  slot, video, index, total, neutral,
  onOlder, onNewer, onPin, onPinNext, onOpen, onIntervalChange, pinning, pinned, pinningNext, loading,
}: {
  slot: PlatformSlot; video: SlimVideo | undefined; index: number; total: number; neutral?: boolean;
  onOlder: () => void; onNewer: () => void; onPin: () => void; onPinNext: () => void; onOpen: () => void;
  onIntervalChange: (d: number) => void; pinning: boolean; pinned: boolean; pinningNext: boolean; loading: boolean;
}) {
  const cfg     = neutral ? NEUTRAL_CFG : PLATFORM_CFG[slot.platform];
  const Icon    = cfg.icon;
  const urgency = slot.nextDate ? getUrgency(slot.nextDate) : "ok";

  return (
    <motion.div
      layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}
      className="flex items-center gap-3 px-3.5 py-3 rounded-xl bg-card border border-border"
    >
      <div className={`w-9 h-9 min-w-9 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
        <Icon className="w-4 h-4 text-white" />
      </div>

      <div className="w-[84px] flex-shrink-0">
        <p className="text-xs font-semibold text-foreground leading-tight">{cfg.label}</p>
        <p className={`text-[10px] font-medium mt-0.5 ${URG_TEXT[urgency]}`}>
          {slot.nextDate ? urgencyLabel(slot.nextDate) : "sin fecha"}
        </p>
      </div>

      <div className="flex-1 flex items-center gap-1.5 min-w-0">
        <button onClick={onOlder} disabled={loading || index >= total - 1}
          className="p-0.5 rounded hover:bg-secondary disabled:opacity-20 transition-colors flex-shrink-0">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0 text-center px-1">
          {loading ? (
            <p className="text-xs text-muted-foreground">…</p>
          ) : total === 0 ? (
            <p className="text-xs text-muted-foreground">Sin videos</p>
          ) : (
            <>
              <p className="text-xs font-medium text-foreground truncate">{video?.title ?? "—"}</p>
              <p className="text-[10px] text-muted-foreground tabular-nums">{total > 0 ? `${index + 1} / ${total}` : ""}</p>
            </>
          )}
        </div>
        <button onClick={onNewer} disabled={loading || index <= 0}
          className="p-0.5 rounded hover:bg-secondary disabled:opacity-20 transition-colors flex-shrink-0">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="hidden sm:flex flex-col items-end gap-0.5 flex-shrink-0 w-[72px]">
        {slot.nextDate && (
          <span className="text-[10px] text-muted-foreground">{formatShortDate(slot.nextDate)}</span>
        )}
        <IntervalChip days={slot.intervalDays} onChange={onIntervalChange} />
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={onOpen}
          disabled={loading || !video}
          title="Ver video"
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-20 transition-colors"
        >
          <Clapperboard className="w-4 h-4" />
        </button>
        <button
          onClick={onPinNext}
          disabled={loading || pinningNext || !video}
          title="Fijar como próximo a publicar, sin marcarlo publicado"
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-20 transition-colors"
        >
          {pinningNext ? <Loader2 className="w-4 h-4 animate-spin" /> : <SkipForward className="w-4 h-4" />}
        </button>
        <button
          onClick={onPin}
          disabled={loading || pinning || pinned || !video}
          title={pinned ? "Fijado" : "Fijar como publicado y avanzar"}
          className={`p-1.5 rounded-lg transition-colors ${
            pinned ? "text-emerald-500 bg-emerald-500/10 cursor-default" : "text-primary hover:bg-primary/10 disabled:opacity-30"
          }`}
        >
          {pinning ? <Loader2 className="w-4 h-4 animate-spin" /> : pinned ? <Check className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
        </button>
      </div>
    </motion.div>
  );
}

function HistoryRow({ data }: { data: PublishedVideo }) {
  const cfg       = PLATFORM_CFG[data.platform];
  const Icon      = cfg.icon;
  const chips     = getStatChips(data.stats, data.platform).slice(0, 3);
  const thumbnail = data.stats?.thumbnail as string | undefined;
  const empty     = !data.platformId;

  return (
    <div className="flex flex-col gap-2 px-3.5 py-3 rounded-xl bg-card border border-border">
      <div className="flex items-center gap-3">
        {thumbnail ? (
          <div className="rounded-lg overflow-hidden bg-black flex-shrink-0" style={{ width: 44, aspectRatio: "9/16" }}>
            <img src={thumbnail} alt="" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className={`rounded-lg flex items-center justify-center flex-shrink-0 bg-gradient-to-br ${cfg.grad}`} style={{ width: 44, aspectRatio: "9/16" }}>
            <Icon className="w-5 h-5 text-white/90" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`w-3 h-3 rounded-sm flex-shrink-0 ${cfg.bg}`} />
            <span className="text-xs font-semibold text-foreground">{cfg.label}</span>
            {data.publishedAt && (
              <span className="text-[10px] text-muted-foreground">· {formatLongDate(data.publishedAt)}</span>
            )}
          </div>
          {empty ? (
            <p className="text-xs text-muted-foreground mt-0.5">Sin publicaciones</p>
          ) : (
            <>
              <p className="text-xs font-medium text-foreground truncate mt-0.5">{data.fileName ?? data.title ?? "—"}</p>
              {data.fileName && data.title && (
                <p className="text-[10px] text-muted-foreground truncate italic">{data.title}</p>
              )}
            </>
          )}
        </div>

        {data.platformUrl && data.platform !== "tiktok" && (
          <a href={data.platformUrl} target="_blank" rel="noopener noreferrer"
            className="text-sm text-primary hover:underline flex-shrink-0">↗</a>
        )}
      </div>

      {!empty && (
        <div className="flex items-center gap-4 pl-[56px]">
          {chips.map(({ Icon: StatIcon, v }, i) => (
            <div key={i} className="flex items-center gap-1" title={v}>
              <StatIcon className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-foreground tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="h-px flex-1 bg-border" />
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PC — diseño 1.0.34: grid de 3 tarjetas (próximas) + 3 tarjetas (últimas)
// ══════════════════════════════════════════════════════════════════════════════

function UrgencyPill({ urgency, nextDate, onEdit }: { urgency: Urgency; nextDate: string; onEdit?: () => void }) {
  const label = daysLabel(nextDate);
  const styles: Record<Urgency, string> = {
    today: "bg-orange-500/15 text-orange-500",
    soon:  "bg-amber-400/15 text-amber-600",
    ok:    "bg-secondary text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${styles[urgency]}`}>
      <Clock className="w-3 h-3" />
      {label}
      {onEdit && (
        <button onClick={onEdit} title="Editar intervalo" className="ml-0.5 -mr-0.5 p-0.5 rounded-full hover:bg-black/10 transition-colors">
          <Pencil className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

function VideoSwitcher({
  videos, index, onOlder, onNewer, onPin, onPinNext, onOpen, pinning, pinned, pinningNext,
}: {
  videos: SlimVideo[]; index: number;
  onOlder: () => void; onNewer: () => void; onPin: () => void; onPinNext: () => void; onOpen: () => void;
  pinning: boolean; pinned: boolean; pinningNext: boolean;
}) {
  if (videos.length === 0) {
    return (
      <div className="p-3 rounded-xl border border-dashed border-border text-center">
        <p className="text-sm text-muted-foreground">Sin videos disponibles</p>
      </div>
    );
  }

  const video = videos[index];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button onClick={onOlder} disabled={index === videos.length - 1}
          className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0">
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0 px-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate flex-1">{video?.title}</p>
            <button onClick={onOpen} title="Ver video"
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0">
              <Clapperboard className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{video?.duration}</p>
        </div>

        <button onClick={onNewer} disabled={index === 0}
          className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-1.5">
        <span className="text-xs text-muted-foreground">{index + 1} / {videos.length}</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onPinNext}
            disabled={pinningNext}
            title="Fijar como próximo a publicar, sin marcarlo publicado"
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-border text-foreground hover:bg-secondary transition-colors disabled:opacity-60"
          >
            {pinningNext ? <Loader2 className="w-3 h-3 animate-spin" /> : <SkipForward className="w-3 h-3" />}
            Fijar como próximo
          </button>
          <button
            onClick={onPin}
            disabled={pinning || pinned}
            title="Marca este video como YA publicado y avanza la cola"
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
              pinned ? "bg-emerald-500/15 text-emerald-600 cursor-default" : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            }`}
          >
            {pinning ? <Loader2 className="w-3 h-3 animate-spin" /> : pinned ? <Check className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
            {pinned ? "Fijado" : "Fijar como publicado"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlatformCard({
  slot, videos, index, onOlder, onNewer, onPin, onPinNext, onOpen, onIntervalChange, pinning, pinned, pinningNext, loading, neutral,
}: {
  slot: PlatformSlot; videos: SlimVideo[]; index: number;
  onOlder: () => void; onNewer: () => void; onPin: () => void; onPinNext: () => void; onOpen: () => void;
  onIntervalChange: (days: number) => void; pinning: boolean; pinned: boolean; pinningNext: boolean; loading: boolean; neutral?: boolean;
}) {
  const cfg     = neutral ? NEUTRAL_CFG : PLATFORM_CFG[slot.platform];
  const Icon    = cfg.icon;
  const urgency = slot.nextDate ? getUrgency(slot.nextDate) : "ok";
  const [editingInterval, setEditingInterval] = useState(false);

  return (
    <motion.div
      layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className={`flex flex-col gap-4 p-5 rounded-2xl border bg-card ${
        urgency === "today" ? "border-orange-500/30 shadow-[0_0_0_1px_rgba(249,115,22,0.12)]" : "border-border"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{cfg.label}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Cada {slot.intervalDays} días</p>
        </div>
        {slot.nextDate && (
          editingInterval ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-foreground flex-shrink-0">
              Cada
              <input
                type="number"
                min={1}
                max={60}
                autoFocus
                value={slot.intervalDays}
                onChange={(e) => onIntervalChange(parseInt(e.target.value, 10))}
                onBlur={() => setEditingInterval(false)}
                onKeyDown={(e) => e.key === "Enter" && setEditingInterval(false)}
                className="w-8 text-center bg-transparent border-b border-dashed border-muted-foreground/50 focus:border-primary focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              días
            </span>
          ) : (
            <UrgencyPill urgency={urgency} nextDate={slot.nextDate} onEdit={() => setEditingInterval(true)} />
          )
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground">
          Próxima · {slot.nextDate ? formatDate(slot.nextDate) : "—"}
        </p>

        {loading ? (
          <div className="flex items-center gap-2 p-3 rounded-xl border border-border bg-secondary/30">
            <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            <span className="text-sm text-muted-foreground">Cargando videos…</span>
          </div>
        ) : (
          <VideoSwitcher
            videos={videos}
            index={index}
            onOlder={onOlder}
            onNewer={onNewer}
            onPin={onPin}
            onPinNext={onPinNext}
            onOpen={onOpen}
            pinning={pinning}
            pinned={pinned}
            pinningNext={pinningNext}
          />
        )}
      </div>
    </motion.div>
  );
}

function PublishedCard({ data }: { data: PublishedVideo }) {
  const cfg  = PLATFORM_CFG[data.platform];
  const Icon = cfg.icon;
  // Sin platformId (link/id exacto de la plataforma) igual se puede mostrar el
  // archivo físico si se conoce -- pasa cuando platform_videos quedó desactualizado
  // (wipe de logout) pero el archivo real y su badge sí sobrevivieron.
  const empty = !data.platformId && !data.fileName;

  const getStatusBadgeColor = (status?: string): string => {
    if (!status) return "bg-gray-500/20 text-gray-400";
    const s = status.toLowerCase();
    if (s === "publish_complete" || s === "published") return "bg-emerald-500/20 text-emerald-300";
    if (s === "processing_upload" || s === "processing") return "bg-amber-500/20 text-amber-300";
    if (s === "failed") return "bg-red-500/20 text-red-300";
    return "bg-blue-500/20 text-blue-300";
  };

  const stats = getStatChips(data.stats, data.platform);

  return (
    <div className="flex flex-col gap-2.5 p-4 rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2.5">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
        <p className="text-sm font-semibold text-foreground">{cfg.label}</p>
      </div>

      {empty ? (
        <div className="p-3 rounded-xl border border-dashed border-border text-center">
          <p className="text-sm text-muted-foreground">Sin publicaciones todavía</p>
        </div>
      ) : (
        <>
          <div className="flex gap-3">
            {data.stats?.thumbnail && (
              <div className="rounded-lg overflow-hidden bg-black flex-shrink-0" style={{ width: 64, aspectRatio: "9/16" }}>
                <img src={data.stats.thumbnail} alt="thumbnail" className="w-full h-full object-cover" />
              </div>
            )}

            <div className="flex flex-col gap-1.5 min-w-0 flex-1">
              <div>
                <p className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">Archivo local</p>
                <p className="text-xs font-semibold text-foreground break-words truncate" title={data.fileName || ""}>
                  {data.fileName || "— (sin archivo local)"}
                </p>
              </div>

              {data.title && (
                <div>
                  <p className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">Título</p>
                  <p className="text-xs text-foreground break-words line-clamp-2" title={data.title}>{data.title}</p>
                </div>
              )}
            </div>
          </div>

          <div className={`rounded-xl p-2.5 ${cfg.light} flex flex-col gap-2`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">Estado</p>
              {data.status && (
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${getStatusBadgeColor(data.status)}`}>{data.status}</span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-1.5 text-xs">
              {stats.map(({ Icon: StatIcon, v }, i) => (
                <div key={i} className="flex items-center justify-center gap-1 px-2 py-1 rounded-md bg-black/20" title={v}>
                  <StatIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="font-semibold text-foreground tabular-nums">{v}</span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2">
              <p className={`text-[11px] ${cfg.text}`}>{formatPublishedAt(data.publishedAt)}</p>
              {data.platformUrl && data.platform !== "tiktok" && (
                <a href={data.platformUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-primary hover:underline flex-shrink-0">
                  Ver en {cfg.label}
                </a>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Flujo simple: tarjeta de historial fusionada (PC) ────────────────────────
// En vez de elegir una plataforma "canónica" y ocultar las otras 2 (perdiendo
// sus stats reales), se muestran juntas todas las que efectivamente recibieron
// ESE video — cada una con sus propios likes/vistas/comentarios — más un total
// de vistas sumado.
function MergedPublishedCard({ matches, fileName, publishedAt }: {
  matches: { platform: Platform; data: PublishedVideo }[];
  fileName: string | null;
  publishedAt: string | null;
}) {
  if (matches.length === 0) {
    return (
      <div className="flex flex-col gap-2.5 p-4 rounded-2xl border border-border bg-card">
        <p className="text-sm font-semibold text-foreground">Último video publicado</p>
        <div className="p-3 rounded-xl border border-dashed border-border text-center">
          <p className="text-sm text-muted-foreground">Sin publicaciones todavía</p>
        </div>
      </div>
    );
  }

  const totalViews = matches.reduce((sum, m) => sum + getViewsCount(m.data.stats, m.platform), 0);
  const thumbnail  = matches.map(m => m.data.stats?.thumbnail).find(Boolean);

  return (
    <div className="flex flex-col gap-3 p-4 rounded-2xl border border-border bg-card">
      <div className="flex gap-3">
        {thumbnail && (
          <div className="rounded-lg overflow-hidden bg-black flex-shrink-0" style={{ width: 56, aspectRatio: "9/16" }}>
            <img src={thumbnail} alt="thumbnail" className="w-full h-full object-cover" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground truncate" title={fileName || ""}>{fileName || "—"}</p>
          {publishedAt && <p className="text-[11px] text-muted-foreground mt-0.5">{formatPublishedAt(publishedAt)}</p>}
          {totalViews > 0 && (
            <p className="flex items-center gap-1 text-xs font-semibold text-foreground mt-1">
              <Eye className="w-3.5 h-3.5 text-muted-foreground" /> {totalViews.toLocaleString()} vistas totales
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {matches.map(({ platform, data }) => {
          const cfg   = PLATFORM_CFG[platform];
          const Icon  = cfg.icon;
          const chips = getStatChips(data.stats, platform);
          return (
            <div key={platform} className={`flex items-center gap-2 rounded-xl px-2.5 py-2 ${cfg.light}`}>
              <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
                <Icon className="w-3.5 h-3.5 text-white" />
              </div>
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {chips.map(({ Icon: StatIcon, v }, i) => (
                  <span key={i} className="flex items-center gap-1 text-xs text-foreground">
                    <StatIcon className="w-3 h-3 text-muted-foreground flex-shrink-0" /> {v}
                  </span>
                ))}
              </div>
              {data.platformUrl && platform !== "tiktok" && (
                <a href={data.platformUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-primary hover:underline flex-shrink-0">
                  Ver
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Flujo simple: fila de historial fusionada (mobile) ───────────────────────
function MergedHistoryRow({ matches, fileName, publishedAt }: {
  matches: { platform: Platform; data: PublishedVideo }[];
  fileName: string | null;
  publishedAt: string | null;
}) {
  if (matches.length === 0) {
    return (
      <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl bg-card border border-border">
        <p className="text-xs text-muted-foreground">Sin publicaciones todavía</p>
      </div>
    );
  }

  const totalViews = matches.reduce((sum, m) => sum + getViewsCount(m.data.stats, m.platform), 0);

  return (
    <div className="flex flex-col gap-2 px-3.5 py-3 rounded-xl bg-card border border-border">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground truncate" title={fileName || ""}>{fileName ?? "—"}</p>
        {totalViews > 0 && (
          <span className="flex items-center gap-1 text-[11px] font-semibold text-foreground flex-shrink-0">
            <Eye className="w-3 h-3 text-muted-foreground" /> {totalViews.toLocaleString()}
          </span>
        )}
      </div>
      {publishedAt && <p className="text-[10px] text-muted-foreground">{formatLongDate(publishedAt)}</p>}
      <div className="flex flex-wrap gap-2">
        {matches.map(({ platform, data }) => {
          const cfg   = PLATFORM_CFG[platform];
          const Icon  = cfg.icon;
          const chips = getStatChips(data.stats, platform).slice(0, 3);
          return (
            <div key={platform} className={`flex items-center gap-1.5 rounded-lg px-2 py-1 ${cfg.light}`}>
              <Icon className={`w-3 h-3 ${cfg.text}`} />
              {chips.map(({ Icon: StatIcon, v }, i) => (
                <span key={i} className="flex items-center gap-0.5 text-[10px] text-foreground">
                  <StatIcon className="w-2.5 h-2.5 text-muted-foreground flex-shrink-0" /> {v}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Cache en memoria (sobrevive a montar/desmontar la vista, no a recargar la página) ──

type CalendarCache = {
  videos:    SlimVideo[];
  slots:     PlatformSlot[];
  published: PublishedVideo[];
  indices:   Record<Platform, number>;
};

let calendarCache: CalendarCache | null = null;

function patchCalendarCache(patch: Partial<CalendarCache>) {
  if (!calendarCache) return;
  calendarCache = { ...calendarCache, ...patch };
}

// ── Main component ────────────────────────────────────────────────────────────

export function PublishingQueue({ role: _role, onOpenVideo }: { role: string; onOpenVideo?: (fileId: string, title: string) => void }) {
  const [videos,    setVideos]    = useState<SlimVideo[]>(calendarCache?.videos ?? []);
  const [slots,     setSlots]     = useState<PlatformSlot[]>(calendarCache?.slots ?? FALLBACK_SLOTS);
  const [loading,   setLoading]   = useState(!calendarCache);
  const [published, setPublished] = useState<PublishedVideo[]>(calendarCache?.published ?? []);
  const [refreshing, setRefreshing] = useState(false);

  const [indices, setIndices] = useState<Record<Platform, number>>(calendarCache?.indices ?? { tiktok: 0, instagram: 0, youtube: 0 });
  const [pinning, setPinning] = useState<Record<Platform, boolean>>({ tiktok: false, instagram: false, youtube: false });
  const [pinned,  setPinned]  = useState<Record<Platform, boolean>>({ tiktok: false, instagram: false, youtube: false });
  const [pinningNext, setPinningNext] = useState<Record<Platform, boolean>>({ tiktok: false, instagram: false, youtube: false });

  // Flujo simple: las 3 plataformas avanzan siempre juntas — se colapsa la UI a
  // una sola tarjeta/fila, pero las acciones (fijar, navegar, cambiar intervalo)
  // se aplican a las 3 por debajo para mantenerlas sincronizadas.
  const [workflowMode, setWorkflowModeState] = useState<WorkflowMode | null>(null);
  useEffect(() => { setupService.getWorkflowMode().then(d => setWorkflowModeState(d.workflowMode)).catch(() => {}); }, []);
  const isSimple: boolean = workflowMode === "simple";
  const ALL_PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

  // Cada tarjeta solo debe ofrecer videos que todavía le faltan a ESA plataforma
  // (ni publicados ni descartados ahí) — mismo criterio que la vista de Videos,
  // pero filtrado además por plataforma en vez de agregado.
  const videosForPlatform = (p: Platform): SlimVideo[] =>
    videos.filter(v => !(v.platforms ?? []).includes(p) && !(v.platforms_discarded ?? []).includes(p));

  function loadAll(showRefresh = false) {
    if (showRefresh) setRefreshing(true);
    let loadedVideos: SlimVideo[] = [];
    // BUG real encontrado 2026-09-03: /api/sync/calendar-config está proxeado
    // 100% a la central (auth-proxy.routes.ts) -- su nextVideoId es un
    // ObjectId de Mongo, nunca el id local (SQLite, entero) de SlimVideo.fileId.
    // Comparar por id acá SIEMPRE fallaba en silencio (no es específico del
    // wipe/recuperación), y el fallback por título comparaba contra el mismo
    // ObjectId en vez del título real -- por eso el "próximo" mostrado nunca
    // coincidía con lo fijado/calculado en la central, cayendo siempre al
    // default (el pendiente más viejo). Se guardan ambos valores y se matchea
    // por título como vía real (fileId se conserva por si algún día se expone
    // un id local-compatible desde el endpoint).
    let loadedNextIds: Partial<Record<Platform, { id: string; title: string | null }>> = {};
    let builtSlots: PlatformSlot[] = FALLBACK_SLOTS;
    let loadedPublished: PublishedVideo[] = [];
    let videosOk = false;
    let configOk = false;
    let publishedOk = false;

    function resolve() {
      if (!videosOk || !configOk || !publishedOk) return;
      setLoading(false);
      setRefreshing(false);
      const idx: Record<Platform, number> = { tiktok: 0, instagram: 0, youtube: 0 };
      for (const p of ["tiktok", "instagram", "youtube"] as Platform[]) {
        const list = loadedVideos.filter(v => !(v.platforms ?? []).includes(p) && !(v.platforms_discarded ?? []).includes(p));
        // Sin nextVideoId confiable (nunca se fijó, o el video ya no existe):
        // el default es el pendiente más VIEJO de esta plataforma — la lista
        // viene de más nuevo a más viejo, así que es el último índice — no el
        // más nuevo (índice 0), que es lo que se mostraba antes por defecto.
        idx[p] = Math.max(0, list.length - 1);
        const next = loadedNextIds[p];
        if (!next) continue;
        let found = list.findIndex(v => v.fileId === next.id);
        if (found === -1 && next.title) found = list.findIndex(v => v.title === next.title);
        if (found !== -1) idx[p] = found;
      }
      setIndices(idx);
      calendarCache = { videos: loadedVideos, slots: builtSlots, published: loadedPublished, indices: idx };
    }

    videoService.getSlimList()
      .then(v => { loadedVideos = v; setVideos(v); })
      .catch(() => {})
      .finally(() => { videosOk = true; resolve(); });

    syncService.getCalendarConfig()
      .then(data => {
        const built: PlatformSlot[] = (["tiktok", "instagram", "youtube"] as Platform[]).map(p => {
          const cfg = data.find(c => c.platform === p);
          if (!cfg) return FALLBACK_SLOTS.find(s => s.platform === p)!;
          if (cfg.nextVideoId) loadedNextIds[p] = { id: cfg.nextVideoId, title: cfg.nextVideo?.title ?? null };
          const intervalDays = cfg.intervalDays ?? 3;
          return {
            platform: p,
            lastTitle: cfg.lastPublishedTitle,
            lastDate: cfg.lastPublishedDate,
            lastVideoId: cfg.lastVideoId,
            intervalDays,
            nextDate: cfg.lastPublishedDate ? calcNextDate(cfg.lastPublishedDate, intervalDays) : "",
          };
        });
        builtSlots = built;
        setSlots(built);
      })
      .catch(() => {})
      .finally(() => { configOk = true; resolve(); });

    syncService.getPublishedVideos()
      .then(data => { loadedPublished = data as PublishedVideo[]; setPublished(loadedPublished); })
      .catch(() => {})
      .finally(() => { publishedOk = true; resolve(); });
  }

  // Si ya hay cache, la vista se pinta al instante con esos datos y se refresca
  // en segundo plano. La publicación puede ocurrir en iOS/Android mientras
  // Electron permanece abierto, por lo que también debemos volver a consultar
  // calendario, videos e historial sin exigir desmontar la vista.
  useEffect(() => {
    loadAll();
    const refresh = () => loadAll();
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, []);

  function updateInterval(platform: Platform, days: number) {
    if (!Number.isFinite(days) || days < 1) return;
    const affected = isSimple ? ALL_PLATFORMS : [platform];
    setSlots(prev => {
      const next = prev.map(s =>
        affected.includes(s.platform)
          ? { ...s, intervalDays: days, nextDate: s.lastDate ? calcNextDate(s.lastDate, days) : s.nextDate }
          : s
      );
      patchCalendarCache({ slots: next });
      return next;
    });
    affected.forEach(p => syncService.updateCalendarConfig(p, { intervalDays: days }).catch(() => {}));
  }

  function navigate(platform: Platform, dir: "older" | "newer") {
    const affected = isSimple ? ALL_PLATFORMS : [platform];
    setIndices(prev => {
      const next = { ...prev };
      for (const p of affected) {
        const len = videosForPlatform(p).length;
        next[p] = dir === "older" ? Math.min(len - 1, prev[p] + 1) : Math.max(0, prev[p] - 1);
      }
      return next;
    });
    setPinned(prev => {
      const next = { ...prev };
      affected.forEach(p => { next[p] = false; });
      return next;
    });
  }

  async function pinVideo(platform: Platform) {
    const affected = isSimple ? ALL_PLATFORMS : [platform];
    const list = videosForPlatform(platform);
    const video = list[indices[platform]];
    if (!video) return;
    const today = todayStr();
    const nextIdx = Math.max(0, indices[platform] - 1);
    // El video que se acaba de pinnear deja de estar pendiente para "affected" —
    // se proyecta ese cambio ANTES de leer "próximo", si no seguiría ofreciendo
    // el mismo video recién publicado en la tarjeta.
    const projectedVideos = videos.map(v =>
      v.fileId === video.fileId
        ? {
            ...v,
            platforms: Array.from(new Set([...(v.platforms ?? []), ...affected])),
            platforms_discarded: (v.platforms_discarded ?? []).filter(p => !affected.includes(p)),
          }
        : v
    );
    const nextVideo = projectedVideos
      .filter(v => !(v.platforms ?? []).includes(platform) && !(v.platforms_discarded ?? []).includes(platform))[nextIdx];

    setPinning(prev => ({ ...prev, [platform]: true }));
    try {
      await Promise.all(affected.map(p => {
        const slot = slots.find(s => s.platform === p);
        const intervalDays = slot?.intervalDays ?? 3;
        return syncService.updateCalendarConfig(p, {
          lastPublishedDate:  today,
          lastPublishedTitle: video.title,
          lastVideoId:        video.fileId,
          intervalDays,
          nextVideoId:        nextVideo?.title,
        });
      }));
      // Sin esto, el video queda "pendiente" para siempre en la lista general de
      // Videos (esa vista oculta por defecto solo lo que ya está resuelto en las
      // 3 plataformas) aunque acá lo hayamos marcado publicado — se acumulaba
      // como conteo inflado e innecesario.
      await videoService.updateVideosBulk([String(video.fileId)], { platforms: affected, platformState: "publicado" }).catch(() => {});
      setVideos(projectedVideos);
      patchCalendarCache({ videos: projectedVideos });
      setSlots(prev => {
        const next = prev.map(s =>
          affected.includes(s.platform)
            ? { ...s, lastTitle: video.title, lastDate: today, lastVideoId: video.fileId, nextDate: calcNextDate(today, s.intervalDays) }
            : s
        );
        patchCalendarCache({ slots: next });
        return next;
      });
      setPinned(prev => {
        const next = { ...prev };
        affected.forEach(p => { next[p] = true; });
        return next;
      });
      setIndices(prev => {
        const next = { ...prev };
        affected.forEach(p => { next[p] = nextIdx; });
        patchCalendarCache({ indices: next });
        return next;
      });
    } catch { /* no-op */ }
    finally { setPinning(prev => ({ ...prev, [platform]: false })); }
  }

  // A diferencia de pinVideo, NO marca el archivo como publicado — solo mueve el
  // puntero "próximo" del calendario al video que se está mirando en el switcher.
  // Sirve para reordenar la cola (publicar este antes que otro) sin declarar una
  // publicación que todavía no pasó (eso rompía el calendario, ver conversación
  // sobre "final - oneplus" quedando fijo como próximo de TikTok aunque ya
  // estaba publicado).
  async function pinNextVideo(platform: Platform) {
    const affected = isSimple ? ALL_PLATFORMS : [platform];
    const video = videosForPlatform(platform)[indices[platform]];
    if (!video) return;
    setPinningNext(prev => ({ ...prev, [platform]: true }));
    try {
      // video.fileId es el id local (SQLite) del switcher, no el _id de Mongo —
      // la central no puede resolverlo. Igual que nextVideoId en pinVideo, hay
      // que mandar el file_name (título): getCalendarConfig lo resuelve con el
      // mismo fallback por nombre que usa en todos lados para cruzar PC↔central.
      await Promise.all(affected.map(p => syncService.updateCalendarConfig(p, { nextVideoId: video.title })));
    } catch { /* no-op */ }
    finally { setPinningNext(prev => ({ ...prev, [platform]: false })); }
  }

  const slotFor = (p: Platform) => slots.find(s => s.platform === p) ?? FALLBACK_SLOTS.find(s => s.platform === p)!;
  // Simple: colapsa a una sola tarjeta — la plataforma con el lastDate más
  // reciente entre las 3 (la que de verdad avanzó última). El resto de la UI
  // (grillas y buckets de urgencia) se arma sobre este ORDER sin cambios.
  const canonicalPlatform: Platform = [...ALL_PLATFORMS]
    .filter(p => slotFor(p).lastDate)
    .sort((a, b) => (slotFor(b).lastDate || "").localeCompare(slotFor(a).lastDate || ""))[0] ?? "youtube";
  const ORDER: Platform[] = isSimple ? [canonicalPlatform] : ["youtube", "instagram", "tiktok"];
  const byDate = (a: { slot: PlatformSlot }, b: { slot: PlatformSlot }) =>
    (a.slot.nextDate || "9999").localeCompare(b.slot.nextDate || "9999");

  const withUrg = ORDER.map(p => {
    const slot = slotFor(p);
    const urg: Urgency = slot.nextDate ? getUrgency(slot.nextDate) : "ok";
    return { p, slot, urg };
  });
  const todayB   = withUrg.filter(x => x.urg === "today").sort(byDate);
  const soonB    = withUrg.filter(x => x.urg === "soon").sort(byDate);
  const laterB   = withUrg.filter(x => x.urg === "ok").sort(byDate);

  const history = ORDER
    .map(p => published.find(d => d.platform === p) ?? { platform: p, fileName: null, fileId: null, platformId: null, platformUrl: null, publishedAt: null } as PublishedVideo)
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));

  // Simple: en vez de mostrar solo la plataforma canónica, se muestran juntas
  // TODAS las que realmente publicaron ese mismo video (matcheando por nombre
  // de archivo/título contra el slot canónico), cada una con sus stats reales.
  const canonicalSlot   = slotFor(canonicalPlatform);
  const canonicalTitle  = canonicalSlot.lastTitle;
  const matchedPublished = canonicalTitle
    ? ALL_PLATFORMS
        .map(p => ({ platform: p, data: published.find(d => d.platform === p) }))
        .filter((x): x is { platform: Platform; data: PublishedVideo } =>
          !!x.data && !!x.data.platformId && (x.data.fileName === canonicalTitle || x.data.title === canonicalTitle))
    : [];

  const renderMobileCard = ({ p, slot }: { p: Platform; slot: PlatformSlot }) => {
    const platformVideos = videosForPlatform(p);
    const currentVideo = platformVideos[indices[p]];
    return (
      <UpcomingCard
        key={p} slot={slot} video={currentVideo} index={indices[p]} total={platformVideos.length} neutral={isSimple}
        onOlder={() => navigate(p, "older")} onNewer={() => navigate(p, "newer")} onPin={() => pinVideo(p)} onPinNext={() => pinNextVideo(p)}
        onOpen={() => currentVideo && onOpenVideo?.(currentVideo.fileId, currentVideo.title)}
        onIntervalChange={d => updateInterval(p, d)} pinning={pinning[p]} pinned={pinned[p]} pinningNext={pinningNext[p]} loading={loading}
      />
    );
  };

  return (
    <div className="flex flex-col gap-5 pb-4 w-full">

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground mt-0.5">Hoy, {formatLongDate(todayStr())}</p>
        </div>
        <button
          onClick={() => loadAll(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Actualizar
        </button>
      </div>

      {loading && videos.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* ── PC (lg+): diseño 1.0.34 — grid de 3 tarjetas (próximas) + 3 (últimas) ── */}
          <div className="hidden lg:flex lg:flex-col gap-6">
            <section className="flex flex-col gap-3">
              <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground px-1">Próximas publicaciones</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {ORDER.map(p => {
                  const platformVideos = videosForPlatform(p);
                  const currentVideo = platformVideos[indices[p]];
                  return (
                    <PlatformCard
                      key={p}
                      slot={slotFor(p)}
                      videos={platformVideos}
                      index={indices[p]}
                      onOlder={() => navigate(p, "older")}
                      onNewer={() => navigate(p, "newer")}
                      onPin={() => pinVideo(p)}
                      onPinNext={() => pinNextVideo(p)}
                      onOpen={() => currentVideo && onOpenVideo?.(currentVideo.fileId, currentVideo.title)}
                      onIntervalChange={d => updateInterval(p, d)}
                      pinning={pinning[p]}
                      pinned={pinned[p]}
                      pinningNext={pinningNext[p]}
                      loading={loading}
                      neutral={isSimple}
                    />
                  );
                })}
              </div>
            </section>

            <section className="flex flex-col gap-3 border-t border-border pt-5">
              <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground px-1">Último video publicado</p>
              {isSimple ? (
                <div className="max-w-md">
                  <MergedPublishedCard matches={matchedPublished} fileName={canonicalTitle} publishedAt={canonicalSlot.lastDate} />
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {ORDER.map(p => {
                    const data = published.find(d => d.platform === p)
                      ?? { platform: p, fileName: null, fileId: null, platformId: null, platformUrl: null, publishedAt: null } as PublishedVideo;
                    return <PublishedCard key={p} data={data} />;
                  })}
                </div>
              )}
            </section>
          </div>

          {/* ── Mobile (< lg): feed por urgencia ── */}
          <div className="lg:hidden flex flex-col gap-5">
            {todayB.length > 0 && (
              <section className="flex flex-col gap-2">
                <p className="text-[11px] uppercase tracking-wide font-semibold text-orange-500 px-1">Hoy</p>
                {todayB.map(x => renderMobileCard(x))}
              </section>
            )}
            {soonB.length > 0 && (
              <section className="flex flex-col gap-2">
                <p className="text-[11px] uppercase tracking-wide font-semibold text-amber-500 px-1">Mañana</p>
                {soonB.map(x => renderMobileCard(x))}
              </section>
            )}
            {laterB.length > 0 && (
              <section className="flex flex-col gap-2">
                <p className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground px-1">Próximo</p>
                {laterB.map(x => renderMobileCard(x))}
              </section>
            )}
            <section className="flex flex-col gap-2 mt-1">
              <Divider label="Últimos publicados" />
              {isSimple
                ? <MergedHistoryRow matches={matchedPublished} fileName={canonicalTitle} publishedAt={canonicalSlot.lastDate} />
                : history.map(d => <HistoryRow key={d.platform} data={d} />)}
            </section>
          </div>
        </>
      )}

    </div>
  );
}
