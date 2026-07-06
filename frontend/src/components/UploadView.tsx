import { useState, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { setupService, WorkflowMode } from "../services/api";
import { YoutubeUploadView } from "./YoutubeUploadView";
import { SimpleUploadView } from "./SimpleUploadView";

export function UploadView() {
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode | null>(null);
  const [manualMode, setManualMode]     = useState(false);

  useEffect(() => {
    setupService.getWorkflowMode().then(d => setWorkflowMode(d.workflowMode)).catch(() => {});
  }, []);

  if (workflowMode !== "simple" || manualMode) {
    return (
      <div className="space-y-3">
        {workflowMode === "simple" && (
          <div className="max-w-4xl mx-auto">
            <button onClick={() => setManualMode(false)}
              className="flex items-center gap-1.5 text-xs text-primary hover:underline">
              <ArrowLeft className="w-3.5 h-3.5" /> Volver al flujo simple
            </button>
          </div>
        )}
        <YoutubeUploadView />
      </div>
    );
  }

  return <SimpleUploadView onManualMode={() => setManualMode(true)} />;
}
