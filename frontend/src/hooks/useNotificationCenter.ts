import { useEffect, useRef, useState } from "react";
import { usePluginActivity, phaseLabel } from "./usePluginActivity";
import { useUploadActivity, uploadPhaseLabel } from "./useUploadActivity";

export interface NotificationItem {
  id: string;
  label: string;
  status: "running" | "done";
  updatedAt: number;
}

const PLATFORM_LABELS: Record<string, string> = {
  youtube:   "YouTube",
  instagram: "Instagram",
  tiktok:    "TikTok",
};

function transcriptionLabel(a: NonNullable<ReturnType<typeof usePluginActivity>>): string {
  const suffix = a.current && a.total ? ` (${a.current}/${a.total})` : "";
  return `${phaseLabel(a.phase)}${a.title ? `: ${a.title}` : ""}${suffix}`;
}

function uploadLabel(a: NonNullable<ReturnType<typeof useUploadActivity>>): string {
  const platform = PLATFORM_LABELS[a.platform] ?? a.platform;
  const pct = a.percent != null ? ` ${a.percent}%` : "";
  return `${uploadPhaseLabel(a.phase)} a ${platform}${pct}`;
}

/** Centro de notificaciones: une actividad de transcripción (usePluginActivity)
 * y de subida (useUploadActivity) en una sola lista persistida en memoria
 * (dropdown de la campana) + una señal de "nube" transitoria que se muestra
 * sola 5s cada vez que algo cambia y se cierra sola cuando deja de haber novedades. */
export function useNotificationCenter(enabled: boolean) {
  const pluginActivity = usePluginActivity(enabled);
  const uploadActivity = useUploadActivity(enabled);

  const [items, setItems] = useState<Record<string, NotificationItem>>({});
  const [cloudOpen, setCloudOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSignature = useRef<string>("");

  useEffect(() => {
    const now = Date.now();
    setItems(prev => {
      const next = { ...prev };

      if (pluginActivity) {
        next.transcription = { id: "transcription", label: transcriptionLabel(pluginActivity), status: "running", updatedAt: now };
      } else if (next.transcription?.status === "running") {
        next.transcription = { ...next.transcription, label: `${next.transcription.label} — listo`, status: "done", updatedAt: now };
      }

      if (uploadActivity) {
        next.upload = { id: "upload", label: uploadLabel(uploadActivity), status: "running", updatedAt: now };
      } else if (next.upload?.status === "running") {
        next.upload = { ...next.upload, label: `${next.upload.label} — listo`, status: "done", updatedAt: now };
      }

      return next;
    });

    const signature = JSON.stringify([pluginActivity, uploadActivity]);
    if (signature !== lastSignature.current) {
      lastSignature.current = signature;
      // "[null,null]" es el estado de reposo inicial — no dispara nube.
      if (signature !== JSON.stringify([null, null]) || hideTimer.current) {
        setCloudOpen(true);
        setUnread(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setCloudOpen(false), 5000);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pluginActivity), JSON.stringify(uploadActivity)]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const list = Object.values(items).sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    notifications: list,
    cloudOpen,
    unread,
    markRead: () => setUnread(false),
  };
}
