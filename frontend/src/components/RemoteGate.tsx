import { ReactNode } from "react";
import { motion } from "motion/react";
import { Wifi, Star, Monitor, LogOut } from "lucide-react";
import { useAuth } from "../hooks/useAuth";

const isRemoteAccess = (): boolean => {
  const h = window.location.hostname;
  return h !== "localhost" && h !== "127.0.0.1" && !h.startsWith("192.168.");
};

function UpgradeScreen({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background px-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="max-w-sm w-full text-center space-y-6"
      >
        {/* Icono */}
        <div className="relative mx-auto w-20 h-20">
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Wifi className="w-9 h-9 text-primary/60" />
          </div>
          <div className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
            <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
          </div>
        </div>

        {/* Texto */}
        <div className="space-y-2">
          <h2 className="text-foreground text-xl font-bold">Acceso remoto</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Estás accediendo desde fuera de tu red local. Esta función es exclusiva del plan{" "}
            <span className="text-amber-400 font-semibold">Premium</span>.
          </p>
        </div>

        {/* Qué incluye */}
        <div className="bg-card border border-border rounded-xl p-4 text-left space-y-2.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Premium incluye
          </p>
          {[
            "Acceso desde celular y cualquier dispositivo",
            "Gestión de contenido en movimiento",
            "Publicación remota a YouTube, Instagram y TikTok",
          ].map((f) => (
            <div key={f} className="flex items-start gap-2">
              <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-foreground/80">{f}</span>
            </div>
          ))}
        </div>

        {/* Acceso local */}
        <div className="bg-secondary/40 border border-border rounded-xl p-3 flex items-center gap-2.5 text-left">
          <Monitor className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <p className="text-xs text-muted-foreground">
            Podés seguir usando la app desde tu red local sin restricciones.
          </p>
        </div>

        <p className="text-xs text-muted-foreground/50">
          Contactá al administrador para activar tu acceso premium.
        </p>

        <button
          onClick={onLogout}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mx-auto"
        >
          <LogOut className="w-4 h-4" />
          Cerrar sesión
        </button>
      </motion.div>
    </div>
  );
}

export function RemoteGate({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  if (user && isRemoteAccess() && user.tier === "free") {
    return <UpgradeScreen onLogout={logout} />;
  }

  return <>{children}</>;
}
