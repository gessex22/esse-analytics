import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, Sparkles, SlidersHorizontal, Check } from "lucide-react";
import { setupService, WorkflowMode } from "../services/api";

export function WorkflowSetupModal({ onDone }: { onDone: () => void }) {
  const [saving, setSaving] = useState<WorkflowMode | null>(null);

  const choose = async (mode: WorkflowMode) => {
    setSaving(mode);
    try {
      await setupService.setWorkflowMode(mode);
    } finally {
      onDone();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.15 }}
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg p-6 space-y-5"
      >
        <div>
          <h3 className="text-foreground font-semibold text-base">¿Cómo publicás tus videos?</h3>
          <p className="text-muted-foreground text-xs mt-1 leading-snug">
            Esto define cómo vas a marcar el estado de publicación de cada video. Podés cambiarlo
            después desde Ajustes → Biblioteca.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <button
            onClick={() => choose("simple")}
            disabled={!!saving}
            className="text-left p-4 rounded-xl border border-border bg-secondary/40 hover:border-primary/50 hover:bg-secondary/60 transition-colors disabled:opacity-50 space-y-2"
          >
            <div className="flex items-center gap-2 text-foreground font-medium text-sm">
              <Sparkles className="w-4 h-4 text-primary" /> Simple
              {saving === "simple" && <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />}
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              Publicás en las 3 plataformas a la vez. Cada video tiene un solo estado
              (pendiente / publicado / descartado).
            </p>
          </button>

          <button
            onClick={() => choose("avanzado")}
            disabled={!!saving}
            className="text-left p-4 rounded-xl border border-border bg-secondary/40 hover:border-primary/50 hover:bg-secondary/60 transition-colors disabled:opacity-50 space-y-2"
          >
            <div className="flex items-center gap-2 text-foreground font-medium text-sm">
              <SlidersHorizontal className="w-4 h-4 text-primary" /> Avanzado
              {saving === "avanzado" && <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />}
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              Publicás en cada plataforma por separado, en días distintos. Trackeás
              YouTube, Instagram y TikTok de forma independiente.
            </p>
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground/70 flex items-center gap-1.5">
          <Check className="w-3 h-3 flex-shrink-0" /> Elegí la que más se parezca a como trabajás hoy — no es definitivo.
        </p>
      </motion.div>
    </div>
  );
}
