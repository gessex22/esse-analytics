import { Check, Palette, ShieldCheck, Tv2, FolderOpen } from "lucide-react";
import { useTheme, THEMES, ThemeId } from "../hooks/useTheme";
import { SecurityPanel } from "./SecurityPanel";
import { SyncPanel } from "./SyncPanel";
import { LibraryPanel } from "./LibraryPanel";

const ALL_SECTIONS = [
  { id: "colores",    label: "Colores",        icon: Palette,     roles: ["todopoderoso", "editor"] },
  { id: "biblioteca", label: "Biblioteca",      icon: FolderOpen,  roles: ["todopoderoso"] },
  { id: "seguridad",  label: "Seguridad",       icon: ShieldCheck, roles: ["todopoderoso"] },
  { id: "sync",       label: "Sincronización",  icon: Tv2,         roles: ["todopoderoso"] },
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

interface SettingsViewProps {
  activeSection: string;
  role: string;
  onSectionChange: (id: string) => void;
}

export function SettingsView({ activeSection, role, onSectionChange }: SettingsViewProps) {
  const visibleSections = ALL_SECTIONS.filter(s => s.roles.includes(role));

  return (
    <div className="space-y-5">
      {/* Tabs — solo visibles en mobile, en desktop el sidebar ya tiene el acordeón */}
      {visibleSections.length > 1 && (
        <div className="sm:hidden flex gap-2">
          {visibleSections.map(({ id, label, icon: Icon }) => {
            const isActive = activeSection === id;
            return (
              <button
                key={id}
                onClick={() => onSectionChange(id)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors ${
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
    </div>
  );
}
