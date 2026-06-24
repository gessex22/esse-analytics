export type Platform = "tiktok" | "instagram" | "youtube";

export interface PlatformSlot {
  platform: Platform;
  lastTitle: string;
  lastDate: string;
  lastVideoId?: string;
  nextDate: string;
  intervalDays: number;
}

export function calcNextDate(lastDate: string, intervalDays = 3): string {
  const [y, m, d] = lastDate.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + intervalDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Fallback estático — solo se usa si el backend no responde
export const FALLBACK_SLOTS: PlatformSlot[] = [
  { platform: "tiktok",    lastTitle: "Final Garantía", lastDate: "2026-06-19", intervalDays: 3, nextDate: calcNextDate("2026-06-19", 3) },
  { platform: "instagram", lastTitle: "Lag Minecraft",  lastDate: "2026-06-19", intervalDays: 3, nextDate: calcNextDate("2026-06-19", 3) },
  { platform: "youtube",   lastTitle: "Final Mac Neo",  lastDate: "2026-06-18", intervalDays: 4, nextDate: calcNextDate("2026-06-18", 4) },
];
