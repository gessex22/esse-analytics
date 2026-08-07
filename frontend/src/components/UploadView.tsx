import { useState, useEffect } from "react";
import { ArrowLeft, History } from "lucide-react";
import { setupService, WorkflowMode } from "../services/api";
import { YoutubeUploadView } from "./YoutubeUploadView";
import { SimpleUploadView } from "./SimpleUploadView";

interface UploadViewProps {
  // Acceso directo al historial de subidas/publicaciones desde el propio
  // flujo de Subir -- antes había que salir a otra pestaña de la nav.
  onOpenHistory?: () => void;
}

export function UploadView({ onOpenHistory }: UploadViewProps) {
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode | null>(null);
  const [manualMode, setManualMode]     = useState(false);

  useEffect(() => {
    setupService.getWorkflowMode().then(d => setWorkflowMode(d.workflowMode)).catch(() => {});
  }, []);

  const historyButton = onOpenHistory && (
    <button
      onClick={onOpenHistory}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors flex-shrink-0"
    >
      <History className="w-3.5 h-3.5" />
      Ver historial
    </button>
  );

  if (workflowMode !== "simple" || manualMode) {
    return (
      <div className="space-y-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          {workflowMode === "simple" ? (
            <button onClick={() => setManualMode(false)}
              className="flex items-center gap-1.5 text-xs text-primary hover:underline">
              <ArrowLeft className="w-3.5 h-3.5" /> Volver al flujo simple
            </button>
          ) : <span />}
          {historyButton}
        </div>
        <YoutubeUploadView />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="max-w-4xl mx-auto flex justify-end">{historyButton}</div>
      <SimpleUploadView onManualMode={() => setManualMode(true)} />
    </div>
  );
}
