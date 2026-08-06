import { useEffect, useState, useCallback } from "react";
import {
  Loader2, ShieldCheck, LogIn, Link2, Unlink, UploadCloud, CalendarClock,
  UserCog, ChevronLeft, ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { activityService, AuditEvent, AuditEventType } from "../services/api";

// Vista de solo lectura sobre GET /api/audit-events (Fase 5 del plan de
// estabilidad) -- cada usuario ve SOLO sus propios eventos, sin importar
// desde qué dispositivo se generaron. No hay acciones acá: el log es
// append-only del lado del backend (ver audit-event.model.ts), esta
// pantalla solo lo muestra.

const TYPE_CFG: Record<AuditEventType, { label: string; icon: LucideIcon; text: string; light: string }> = {
  login:                    { label: "Inicio de sesión",        icon: LogIn,        text: "text-blue-500",   light: "bg-blue-500/10"   },
  platform_connect:         { label: "Conexión de plataforma",   icon: Link2,        text: "text-emerald-500", light: "bg-emerald-500/10" },
  platform_disconnect:      { label: "Desconexión de plataforma", icon: Unlink,       text: "text-amber-500",  light: "bg-amber-500/10"  },
  publish_confirmed:        { label: "Publicación",              icon: UploadCloud,  text: "text-primary",    light: "bg-primary/10"    },
  calendar_config_updated:  { label: "Calendario",                icon: CalendarClock, text: "text-purple-500", light: "bg-purple-500/10" },
  account_setting_changed:  { label: "Cuenta",                    icon: UserCog,      text: "text-red-500",    light: "bg-red-500/10"    },
};

const FILTERS: { value: AuditEventType | "all"; label: string }[] = [
  { value: "all",                      label: "Todos"          },
  { value: "login",                    label: "Inicios de sesión" },
  { value: "platform_connect",         label: "Conexiones"     },
  { value: "platform_disconnect",      label: "Desconexiones"  },
  { value: "publish_confirmed",        label: "Publicaciones"  },
  { value: "calendar_config_updated",  label: "Calendario"     },
  { value: "account_setting_changed",  label: "Cuenta"         },
];

const PLATFORM_LABEL: Record<string, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
const SOURCE_LABEL: Record<string, string> = { pc: "PC", desktop: "PC", android: "Android", ios: "iPhone/iPad", web: "Web" };

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Arma el título + detalle legible de cada evento -- el backend guarda datos
// crudos (type/platform/entity/detail), la traducción a texto vive acá.
function describeEvent(item: AuditEvent): { title: string; detail?: string } {
  const platform = item.platform ? (PLATFORM_LABEL[item.platform] ?? item.platform) : null;
  switch (item.type) {
    case "login":
      return { title: "Inicio de sesión" };
    case "platform_connect":
      return { title: `Conectó ${platform ?? "una plataforma"}` };
    case "platform_disconnect":
      return { title: `Desconectó ${platform ?? "una plataforma"}` };
    case "publish_confirmed":
      return {
        title: `Publicó en ${platform ?? "una plataforma"}`,
        detail: item.entity?.label ?? undefined,
      };
    case "calendar_config_updated": {
      const days = item.detail?.intervalDays;
      return {
        title: `Cambió el intervalo de ${platform ?? "calendario"}`,
        detail: typeof days === "number" ? `cada ${days} día${days === 1 ? "" : "s"}` : undefined,
      };
    }
    case "account_setting_changed": {
      const label = item.entity?.label;
      const title = label === "password_reset" ? "Restableció la contraseña"
        : label === "self_deactivated" || label === "deactivated_via_local_reset" ? "Dio de baja la cuenta"
        : "Cambió un ajuste de la cuenta";
      return { title };
    }
    default:
      return { title: item.type };
  }
}

function deviceLabel(item: AuditEvent): string {
  const source = item.source ? (SOURCE_LABEL[item.source] ?? item.source) : null;
  if (item.deviceName && source) return `${item.deviceName} (${source})`;
  return item.deviceName || source || "dispositivo desconocido";
}

const PAGE_SIZE = 20;

export function ActivityView() {
  const [filter, setFilter]           = useState<AuditEventType | "all">("all");
  const [items, setItems]             = useState<AuditEvent[]>([]);
  const [total, setTotal]             = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);

  const load = useCallback((type: AuditEventType | "all", page: number) => {
    setLoading(true);
    setError(null);
    activityService.getEvents({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, type: type === "all" ? undefined : type })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
        setCurrentPage(page);
      })
      .catch((err) => setError(err?.message || "No se pudo cargar la actividad."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(filter, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Actividad</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Registro de inicios de sesión, conexiones y publicaciones de tu cuenta en todos tus dispositivos.
        </p>
        {!loading && total > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            {total} eventos · página {currentPage}/{totalPages}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              filter === value
                ? "bg-primary text-primary-foreground"
                : "bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Cargando actividad…
        </div>
      ) : error ? (
        <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/10 text-red-400 text-sm">{error}</div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <ShieldCheck className="w-8 h-8 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">Todavía no hay actividad registrada.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => {
            const cfg = TYPE_CFG[item.type];
            const Icon = cfg?.icon ?? ShieldCheck;
            const { title, detail } = describeEvent(item);
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-card"
              >
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${cfg?.light ?? "bg-secondary"}`}>
                  <Icon className={`w-4 h-4 ${cfg?.text ?? "text-muted-foreground"}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate" title={title}>
                    {title}{detail && <span className="text-muted-foreground font-normal"> — {detail}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(item.at)}
                    <span className="ml-1.5">· {deviceLabel(item)}</span>
                  </p>
                </div>
              </div>
            );
          })}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                onClick={() => load(filter, currentPage - 1)}
                disabled={currentPage <= 1}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Anterior
              </button>

              <div className="flex items-center gap-1">
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => Math.abs(p - currentPage) <= 2 || p === 1 || p === totalPages)
                  .reduce<(number | "...")[]>((acc, p, i, arr) => {
                    if (i > 0 && (p - (arr[i - 1] as number)) > 1) acc.push("...");
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((item, i) =>
                    item === "..." ? (
                      <span key={`e-${i}`} className="px-2 text-muted-foreground text-sm">…</span>
                    ) : (
                      <button
                        key={item}
                        onClick={() => load(filter, item as number)}
                        className={`w-8 h-8 rounded-lg text-sm transition-colors ${
                          item === currentPage
                            ? "bg-primary text-primary-foreground"
                            : "border border-border hover:bg-secondary text-muted-foreground"
                        }`}
                      >
                        {item}
                      </button>
                    )
                  )}
              </div>

              <button
                onClick={() => load(filter, currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
