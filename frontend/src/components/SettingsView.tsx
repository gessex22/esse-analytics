import { useState } from "react";
import { Check, Palette, ShieldCheck, Tv2, FolderOpen, AlertTriangle, Database, Loader2 } from "lucide-react";
import { useTheme, THEMES, ThemeId } from "../hooks/useTheme";
import { SecurityPanel } from "./SecurityPanel";
import { SyncPanel } from "./SyncPanel";
import { LibraryPanel } from "./LibraryPanel";
import { useAuth } from "../hooks/useAuth";
import { API_BASE } from "../config";

const ALL_SECTIONS = [
  { id: "colores",    label: "Colores",        icon: Palette,     roles: ["todopoderoso", "editor"], localOnly: false },
  { id: "biblioteca", label: "Biblioteca",      icon: FolderOpen,  roles: ["todopoderoso"],           localOnly: false },
  { id: "seguridad",  label: "Seguridad",       icon: ShieldCheck, roles: ["todopoderoso"],           localOnly: false },
  { id: "sync",       label: "Sincronización",  icon: Tv2,         roles: ["todopoderoso"],           localOnly: false },
  { id: "datos",      label: "Datos locales",   icon: Database,    roles: ["todopoderoso"],           localOnly: true  },
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

interface SettingsViewProps {
  activeSection: string;
  role: string;
  isLocal?: boolean;
  onSectionChange: (id: string) => void;
}

export function SettingsView({ activeSection, role, isLocal, onSectionChange }: SettingsViewProps) {
  const visibleSections = ALL_SECTIONS.filter(s =>
    s.roles.includes(role) && (!s.localOnly || isLocal)
  );

  return (
    <div className="space-y-5">
      {/* Tabs — solo visibles en mobile, en desktop el sidebar ya tiene el acordeón */}
      {visibleSections.length > 1 && (
        <div className="sm:hidden flex flex-wrap gap-2">
          {visibleSections.map(({ id, label, icon: Icon }) => {
            const isActive = activeSection === id;
            return (
              <button
                key={id}
                onClick={() => onSectionChange(id)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors shrink-0 ${
                  isActive
                    ? "bg-primary/10 text-primary border-primary/40"
                    : "bg-card/40 text-muted-foreground border-border hover:text-foreground hover:bg-secondary/40"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      )}

      {activeSection === "colores"    && <ColoresPanel />}
      {activeSection === "biblioteca" && <LibraryPanel />}
      {activeSection === "seguridad"  && <SecurityPanel />}
      {activeSection === "sync"       && <SyncPanel />}
      {activeSection === "datos"      && <DatosPanel />}
    </div>
  );
}
