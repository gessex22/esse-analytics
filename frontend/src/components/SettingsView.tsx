import { useState, useEffect, type ReactNode } from "react";
import { Check, Palette, ShieldCheck, Activity, Tv2, FolderOpen, AlertTriangle, Database, Loader2, Cloud, Link2, FileText, ChevronRight, ChevronLeft } from "lucide-react";
import { useTheme, THEMES, ThemeId } from "../hooks/useTheme";
import { SecurityPanel } from "./SecurityPanel";
import { SyncPanel } from "./SyncPanel";
import { LibraryPanel } from "./LibraryPanel";
import { FriedenPanel } from "./FriedenPanel";
import { AccountsPanel } from "./AccountsPanel";
import { ActivityView } from "./ActivityView";
import { useAuth } from "../hooks/useAuth";
import { API_BASE } from "../config";

const ALL_SECTIONS = [
  { id: "colores",    label: "Colores",        icon: Palette,     roles: ["todopoderoso", "editor"], localOnly: false, description: "Elegí la paleta de color de la app" },
  { id: "biblioteca", label: "Biblioteca",      icon: FolderOpen,  roles: ["todopoderoso"],           localOnly: false, description: "Flujo de publicación y carpeta de videos" },
  { id: "cuentas",    label: "Cuentas",         icon: Link2,       roles: ["todopoderoso"],           localOnly: true,  description: "Cuentas conectadas de YouTube, Instagram y TikTok" },
  { id: "seguridad",  label: "Seguridad",       icon: ShieldCheck, roles: ["todopoderoso"],           localOnly: false, description: "Seguridad de la cuenta" },
  // Auditoría central de dispositivos (Fase 5) -- antes ítem propio del sidebar
  // (índice 11), movida acá para no ocupar un slot de nav por una vista de
  // "consultar de vez en cuando" (mismo patrón que Settings > Security log en
  // otros productos), y de paso queda alcanzable en mobile vía Ajustes. No es
  // local-only: lee GET /api/audit-events directo de la central. roles replica
  // el filtro que tenía antes en App.tsx (isNavVisible): todo el mundo salvo editor.
  { id: "actividad",  label: "Actividad",      icon: Activity,    roles: ["todopoderoso", "visitante"], localOnly: false, description: "Inicios de sesión, conexiones y publicaciones de tu cuenta" },
  { id: "sync",       label: "Sincronización",  icon: Tv2,         roles: ["todopoderoso"],           localOnly: false, description: "Emparejar entre plataformas y vincular con archivo local" },
  { id: "frieden",    label: "Remoto y Backup", icon: Cloud,       roles: ["todopoderoso"],           localOnly: true,  description: "Acceso remoto y respaldo en la nube" },
  { id: "datos",      label: "Datos locales",   icon: Database,    roles: ["todopoderoso"],           localOnly: true,  description: "Gestioná los datos guardados en esta instalación" },
  { id: "licencias",  label: "Licencias",       icon: FileText,    roles: ["todopoderoso", "editor"], localOnly: false, description: "Software de terceros incluido en la aplicacion" },
];

function ColoresPanel() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Tema de color</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Cambia la paleta de colores de toda la aplicación
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {THEMES.map((t) => {
          const isActive = theme === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id as ThemeId)}
              className={`relative text-left rounded-xl border p-4 transition-all ${
                isActive
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "border-border bg-card/40 hover:bg-secondary/40"
              }`}
            >
              <div
                className="w-full h-12 rounded-lg mb-3 flex items-end gap-1.5 p-2"
                style={{ background: t.preview.bg }}
              >
                <div className="flex-1 h-3 rounded-sm opacity-80" style={{ background: t.preview.card }} />
                <div className="w-8 h-5 rounded-sm" style={{ background: t.preview.primary }} />
                <div className="w-4 h-3 rounded-sm opacity-60" style={{ background: t.preview.card }} />
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t.name}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{t.description}</p>
                </div>
                {isActive && (
                  <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                    <Check className="w-3 h-3 text-primary-foreground" />
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Nombre editable de ESTA instalación (Fase 5, auditoría) -- GET/PUT
// /api/local/device-name en local-backend, generado la primera vez a partir
// del hostname (getOrCreateDeviceName en local-admin.routes.ts). A diferencia
// de install_id (secreto, nunca sale de SQLite) esto sí es seguro de mostrar/
// editar acá: es solo la etiqueta que va a aparecer en Actividad para
// identificar qué PC hizo cada evento.
function DeviceNamePanel() {
  const { token } = useAuth();
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [draft, setDraft]           = useState("");
  const [editing, setEditing]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/local/device-name`)
      .then(r => r.json())
      .then(d => { setDeviceName(d.deviceName ?? null); setDraft(d.deviceName ?? ""); })
      .catch(() => {});
  }, []);

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/local/device-name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceName: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      setDeviceName(data.deviceName);
      setEditing(false);
    } catch (err: any) {
      setError(err?.message || "No se pudo guardar el nombre.");
    } finally {
      setSaving(false);
    }
  };

  if (deviceName === null) return null;

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4 space-y-2">
      <p className="text-sm font-semibold text-foreground">Nombre de esta PC</p>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Así identificás esta instalación en la pestaña Actividad, entre tus otros dispositivos.
      </p>
      {editing ? (
        <div className="flex gap-2 pt-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={60}
            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={save}
            disabled={saving || !draft.trim()}
            className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Guardar"}
          </button>
          <button
            onClick={() => { setEditing(false); setDraft(deviceName); setError(null); }}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground"
          >
            Cancelar
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between pt-1">
          <span className="text-sm text-foreground">{deviceName}</span>
          <button onClick={() => setEditing(true)} className="text-xs text-primary hover:underline">
            Cambiar
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

function DatosPanel() {
  const { token, logout } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const handleReset = async () => {
    setLoading(true);
    setError(null);
    try {
      await fetch(`${API_BASE}/api/local/wipe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* si falla el wipe, igual limpiamos local */ }

    try {
      await fetch(`${API_BASE}/api/local/owner/reset`, { method: "POST" });
    } catch { /* idem */ }

    logout();
    window.location.reload();
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Datos locales</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Gestiona la información almacenada en esta instalación
        </p>
      </div>

      <DeviceNamePanel />

      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-5 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">Resetear aplicación</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Borra todos los datos locales: cuenta vinculada, biblioteca, caché de videos y configuración.
              La app volverá al estado inicial para que puedas vincular otra cuenta.
            </p>
            <ul className="text-[11px] text-muted-foreground space-y-0.5 mt-2 list-none">
              {["Sesión y token de acceso", "Cuenta vinculada a esta instalación", "Biblioteca local de videos", "Configuración y caché"].map(item => (
                <li key={item} className="flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-red-400/60 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {!confirm ? (
          <button
            onClick={() => setConfirm(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/15 text-red-400 text-sm font-medium hover:bg-red-500/25 transition-colors border border-red-500/30"
          >
            <AlertTriangle className="w-4 h-4" />
            Resetear aplicación
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-red-300 font-medium">¿Seguro? Esta acción no se puede deshacer.</p>
            <div className="flex gap-2">
              <button
                onClick={handleReset}
                disabled={loading}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors disabled:opacity-60"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                {loading ? "Reseteando..." : "Sí, resetear todo"}
              </button>
              <button
                onClick={() => setConfirm(false)}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-card border border-border text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LicenciasPanel() {
  return (
    <div className="space-y-5 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Software de terceros</h3>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          Esta aplicacion incluye FFmpeg para normalizar videos y generar miniaturas. La informacion completa tambien se entrega junto con el instalador.
        </p>
      </div>
      <div className="rounded-xl border border-border bg-card/40 p-4 space-y-3">
        <div>
          <p className="text-sm font-medium text-foreground">FFmpeg 6.1.1</p>
          <p className="text-xs text-muted-foreground mt-1">GPL v3 - compilacion essentials de gyan.dev - incluye libx264 y libx265</p>
        </div>
        <div className="space-y-1.5 text-xs">
          <a className="block text-primary hover:underline" href="https://github.com/FFmpeg/FFmpeg/commit/e38092ef93" target="_blank" rel="noreferrer">Codigo fuente correspondiente (commit exacto)</a>
          <a className="block text-primary hover:underline" href="https://www.gyan.dev/ffmpeg/builds/" target="_blank" rel="noreferrer">Informacion de la compilacion distribuida</a>
          <a className="block text-primary hover:underline" href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noreferrer">Texto de la licencia GPLv3</a>
          <a className="block text-primary hover:underline" href="https://github.com/gessex22/esse-analytics/blob/main/electron/THIRD-PARTY-NOTICES.md" target="_blank" rel="noreferrer">Avisos de terceros de EsseAnalytics</a>
          <a className="block text-primary hover:underline" href="https://github.com/gessex22/esse-analytics/blob/main/electron/FFMPEG-SOURCE-OFFER.md" target="_blank" rel="noreferrer">Registro de fuente y compilacion</a>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-border pt-3">FFmpeg es software de terceros y no es propiedad de EsseAnalytics. Su uso y distribucion estan sujetos a sus licencias correspondientes.</p>
      </div>
    </div>
  );
}

interface SettingsViewProps {
  role: string;
  isLocal?: boolean;
  isPremium?: boolean;
  isOwner?: boolean;
  onOpenVideo?: (fileId: string, title: string) => void;
}

export function SettingsView({ role, isLocal, isPremium, isOwner, onOpenVideo }: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<string | null>(null);

  const visibleSections = ALL_SECTIONS.filter(s => {
    if (!s.roles.includes(role)) return false;
    // Seguridad: solo tiene sentido en la central (remoto) y para el dueño de la cuenta.
    if (s.id === "seguridad") return !isLocal && !!isOwner;
    if (s.localOnly) return isLocal;
    return true;
  });

  const panels: Record<string, ReactNode> = {
    colores:    <ColoresPanel />,
    biblioteca: <LibraryPanel />,
    cuentas:    <AccountsPanel />,
    seguridad:  <SecurityPanel />,
    actividad:  <ActivityView />,
    sync:       <SyncPanel onOpenVideo={onOpenVideo} />,
    frieden:    <FriedenPanel isPremium={!!isPremium} />,
    datos:      <DatosPanel />,
    licencias:  <LicenciasPanel />,
  };

  // Ajustes es un menú (como en celular): cada sección es una fila que lleva a
  // su propia pantalla, en vez de apilar todo el contenido en un solo scroll.
  const active = visibleSections.find(s => s.id === activeSection);
  if (active) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setActiveSection(null)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          Volver a Ajustes
        </button>
        <div className="flex items-center gap-2">
          <active.icon className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">{active.label}</h2>
        </div>
        {panels[active.id]}
      </div>
    );
  }

  return (
    <div className="max-w-lg divide-y divide-border border border-border rounded-xl overflow-hidden">
      {visibleSections.map(({ id, label, icon: Icon, description }) => (
        <button
          key={id}
          onClick={() => setActiveSection(id)}
          className="w-full flex items-center gap-3 text-left px-4 py-3 hover:bg-secondary/40 transition-colors"
        >
          <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium text-foreground">{label}</h2>
            <p className="text-xs text-muted-foreground truncate">{description}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}
