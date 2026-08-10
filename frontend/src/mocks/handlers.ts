// Handlers de MSW -- interceptan cualquier fetch a /api/* sin tocar
// services/api.ts. El "usuario actual" sale de scenarioStore (persistido en
// localStorage), así que cambiar de escenario con MockScenarioSwitcher +
// recargar alcanza para que TODA la app (login, /auth/me, isLocal, etc.)
// reaccione consistente.
import { http, HttpResponse } from "msw";
import { getCurrentScenario } from "./scenarioStore";
import { buildMockToken } from "./scenarios";
import {
  FIXTURE_AUDIT_EVENTS,
  FIXTURE_BACKUP_STATUS,
  FIXTURE_CALENDAR_CONFIG,
  FIXTURE_CALENDAR_VIDEOS,
  FIXTURE_CLOUD_FILES,
  FIXTURE_GEMS,
  FIXTURE_GROUP_STATS,
  FIXTURE_HISTORY,
  FIXTURE_METRICS,
  FIXTURE_USERS,
  FIXTURE_VIDEOS_SLIM,
} from "./fixtures";

export const handlers = [
  // ── Identidad / entorno -- estos 4 son los que realmente deciden qué ve
  // cada escenario (rol/tier/isOwner/hasCloudStorage + local vs remoto). ──
  http.post("*/api/auth/login", () => {
    const scenario = getCurrentScenario();
    return HttpResponse.json({ token: buildMockToken(scenario.user), user: scenario.user });
  }),
  http.get("*/api/auth/me", () => {
    const scenario = getCurrentScenario();
    return HttpResponse.json({ user: scenario.user });
  }),
  http.get("*/api/local/session", () => new HttpResponse(null, { status: 404 })),
  http.get("*/api/local/health", () => {
    const scenario = getCurrentScenario();
    return HttpResponse.json({ local: scenario.isLocal });
  }),

  // ── Contenido -- fixtures estáticas, no varían por escenario. ──
  http.get("*/api/metrics", () => HttpResponse.json(FIXTURE_METRICS)),
  http.get("*/api/videos/slim", () => HttpResponse.json(FIXTURE_VIDEOS_SLIM)),
  http.get("*/api/sync/group-stats", () => HttpResponse.json({ items: FIXTURE_GROUP_STATS })),
  http.get("*/api/sync/history", () => HttpResponse.json({ items: FIXTURE_HISTORY, total: FIXTURE_HISTORY.length })),
  http.get("*/api/sync/calendar-config", () => HttpResponse.json(FIXTURE_CALENDAR_CONFIG)),
  http.get("*/api/calendar", () => HttpResponse.json({ videos: FIXTURE_CALENDAR_VIDEOS })),
  http.get("*/api/audit-events", () => HttpResponse.json(FIXTURE_AUDIT_EVENTS)),
  http.get("*/api/backup/files", () => HttpResponse.json(FIXTURE_CLOUD_FILES)),
  http.get("*/api/local/backup/status", () => HttpResponse.json(FIXTURE_BACKUP_STATUS)),
  http.get("*/api/backup/status", () => HttpResponse.json(FIXTURE_BACKUP_STATUS)),
  http.get("*/api/backup/sync-status", () => HttpResponse.json({ ok: true })),
  http.get("*/api/auth/users", () => HttpResponse.json(FIXTURE_USERS)),
  http.get("*/api/gems", () => HttpResponse.json(FIXTURE_GEMS)),
  http.get("*/api/local/setup/workflow-mode", () => HttpResponse.json({ workflowMode: "avanzado" })),
  http.get("*/api/local/setup/active-platforms", () => HttpResponse.json({ platforms: ["youtube", "instagram", "tiktok"] })),
  // Array-returning: el catch-all de abajo devuelve `{}`, que rompe cualquier
  // código que llame .find()/.map() sobre la respuesta directo (sin wrapper
  // {items:[...]}). Ver README.md -- encontrado en vivo: PublishingQueue.tsx
  // llamaba published.find() y crasheaba toda la app sin error boundary.
  http.get("*/api/publishing-status", () => HttpResponse.json([])),
  http.get("*/api/sync/published-videos", () => HttpResponse.json([])),
  http.get("*/api/ideas-centrales", () => HttpResponse.json([])),
  http.get("*/api/*/auth/status", () => HttpResponse.json({ connected: true })),
  http.get("*/api/youtube/channel-info", () => HttpResponse.json({ title: "Canal Demo" })),
  http.get("*/api/instagram/account-info", () => HttpResponse.json({ username: "demo.ig" })),
  http.get("*/api/tiktok/creator-info", () => HttpResponse.json({ nickname: "demo.tiktok" })),
  // RemoteLibraryPage real: { videos, total, hasMore } -- NO "items" (eso rompía
  // la pestaña Nube con "Cannot read properties of undefined (reading 'length')").
  http.get("*/api/remote-library/videos", () => HttpResponse.json({ videos: [], total: 0, hasMore: false })),
  // Estos 2 hooks tratan CUALQUIER objeto no-null como "hay una actividad en
  // curso" (ver useUploadActivity.ts / useRemoteLibraryPreloadActivity.ts) --
  // el catch-all de abajo devuelve `{}`, que es no-null, y deja un banner
  // fantasma "Guardando en la nube: undefined" pegado en toda la app.
  http.get("*/api/upload-status", () => HttpResponse.json(null)),
  http.get("*/api/remote-library-preload-status", () => HttpResponse.json(null)),

  // ── Catch-all: cualquier /api/* que no esté arriba no debe romper la UI
  // (mutaciones "ok", GETs vacíos-pero-válidos) en vez de tirar 404. Va al
  // final -- MSW usa el primer handler que matchea. ──
  http.get("*/api/*", () => HttpResponse.json({})),
  http.post("*/api/*", () => HttpResponse.json({ ok: true })),
  http.patch("*/api/*", () => HttpResponse.json({ ok: true })),
  http.put("*/api/*", () => HttpResponse.json({ ok: true })),
  http.delete("*/api/*", () => HttpResponse.json({ ok: true })),
];
