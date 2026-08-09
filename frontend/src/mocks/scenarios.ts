// Perfiles de usuario simulados para probar la UI sin backend real. Cada
// escenario define el payload de usuario (lo que decodeJwtUser() de
// useAuth.tsx lee del JWT) + si el "backend" es local o central (lo que
// useBackendType() decide vía /api/local/health, y que gatea RemoteGate +
// LOCAL_ONLY_NAV en App.tsx).
//
// Ver frontend/src/mocks/README.md para cómo usar esto.

export type ScenarioId = "owner" | "editor_free" | "editor_premium_cloud" | "remote_free";

export interface MockUser {
  username: string;
  role: "todopoderoso" | "editor" | "visitante";
  tier: "free" | "premium";
  isOwner: boolean;
  hasCloudStorage: boolean;
  theme?: string;
}

export interface Scenario {
  id: ScenarioId;
  label: string;
  description: string;
  user: MockUser;
  /** Shapea la respuesta de /api/local/health -- decide isLocal en useBackendType. */
  isLocal: boolean;
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  owner: {
    id: "owner",
    label: "Owner (todopoderoso)",
    description: "Ve todo: Usuarios real, todas las gemas, Nube, sin restricciones.",
    user: {
      username: "gessem_demo",
      role: "todopoderoso",
      tier: "premium",
      isOwner: true,
      hasCloudStorage: true,
      theme: "ambar",
    },
    isLocal: true,
  },
  editor_free: {
    id: "editor_free",
    label: "Editor free",
    description: "Perfil más restringido: sin Usuarios real (PRÓXIMAMENTE), sin Nube.",
    user: {
      username: "editor_demo",
      role: "editor",
      tier: "free",
      isOwner: false,
      hasCloudStorage: false,
      theme: "rojo",
    },
    isLocal: true,
  },
  editor_premium_cloud: {
    id: "editor_premium_cloud",
    label: "Editor premium + cloud storage",
    description: "Rol editor pero tier premium y hasCloudStorage -- ve la pestaña Nube.",
    user: {
      username: "premium_demo",
      role: "editor",
      tier: "premium",
      isOwner: false,
      hasCloudStorage: true,
      theme: "ambar",
    },
    isLocal: true,
  },
  remote_free: {
    id: "remote_free",
    label: "Modo remoto (free, fuera de la PC central)",
    description: "isLocal=false + tier free -- dispara el paywall de RemoteGate (UpgradeScreen).",
    user: {
      username: "editor_demo",
      role: "editor",
      tier: "free",
      isOwner: false,
      hasCloudStorage: false,
      theme: "rojo",
    },
    isLocal: false,
  },
};

export const DEFAULT_SCENARIO: ScenarioId = "owner";

// JWT "de mentira" -- decodeJwtUser() en useAuth.tsx solo hace atob() sobre
// el payload, nunca verifica la firma. Alcanza con que tenga 3 partes
// separadas por punto y un payload en base64 válido.
function base64url(json: unknown): string {
  return btoa(JSON.stringify(json)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildMockToken(user: MockUser): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({
    username: user.username,
    role: user.role,
    tier: user.tier,
    isOwner: user.isOwner,
    hasCloudStorage: user.hasCloudStorage,
    theme: user.theme,
    // 1 año -- no queremos que expire a mitad de una sesión de prueba.
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
  });
  return `${header}.${payload}.mock-signature`;
}
