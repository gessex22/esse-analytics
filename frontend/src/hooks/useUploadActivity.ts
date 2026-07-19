import { useEffect, useState } from "react";
import { API_BASE } from "../config";

export interface UploadActivity {
  platform: "youtube" | "instagram" | "tiktok";
  title: string;
  phase: "uploading" | "processing";
  percent?: number;
}

const UPLOAD_PHASE_LABELS: Record<string, string> = {
  uploading:  "Subiendo",
  processing: "Procesando",
};

export function uploadPhaseLabel(phase: string): string {
  return UPLOAD_PHASE_LABELS[phase] ?? phase;
}

/** Poll liviano de /api/upload-status: subidas de YouTube/Instagram/TikTok en curso.
 * Solo tiene sentido en modo local — la subida real la hace el local-backend. */
export function useUploadActivity(enabled: boolean = true) {
  const [activity, setActivity] = useState<UploadActivity | null>(null);

  useEffect(() => {
    if (!enabled) { setActivity(null); return; }
    let alive = true;
    const poll = () => {
      fetch(`${API_BASE}/api/upload-status`)
        .then(r => r.json())
        .then((jobs: UploadActivity[]) => {
          if (!alive) return;
          setActivity(jobs[0] ?? null);
        })
        .catch(() => { if (alive) setActivity(null); });
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [enabled]);

  return activity;
}
