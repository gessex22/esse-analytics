// Panel flotante solo-dev para saltar entre escenarios de usuario sin pasar
// por el login real. Solo se monta cuando el modo mock está activo (ver
// main.tsx) -- nunca entra al bundle de producción porque todo este módulo
// se importa con import() dinámico gateado por import.meta.env.DEV.
import { useState } from "react";
import { SCENARIOS, ScenarioId, buildMockToken } from "./scenarios";
import { getCurrentScenarioId, setCurrentScenario } from "./scenarioStore";

const STORAGE_KEY = "esse_auth_token";

function activate(id: ScenarioId) {
  const scenario = SCENARIOS[id];
  setCurrentScenario(id);
  localStorage.setItem(STORAGE_KEY, buildMockToken(scenario.user));
  window.location.reload();
}

function exitSession() {
  localStorage.removeItem(STORAGE_KEY);
  window.location.reload();
}

export function MockScenarioSwitcher() {
  const [open, setOpen] = useState(true);
  const current = getCurrentScenarioId();

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        zIndex: 99999,
        fontFamily: "monospace",
        fontSize: 12,
        maxWidth: 280,
      }}
    >
      {open ? (
        <div
          style={{
            background: "#111",
            color: "#eee",
            border: "1px solid #444",
            borderRadius: 10,
            padding: 12,
            boxShadow: "0 4px 20px rgba(0,0,0,.4)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ color: "#f59e0b" }}>🎭 MOCK MODE</strong>
            <button onClick={() => setOpen(false)} style={btnStyle}>
              _
            </button>
          </div>
          {Object.values(SCENARIOS).map((s) => (
            <button
              key={s.id}
              onClick={() => activate(s.id)}
              title={s.description}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                marginBottom: 4,
                borderRadius: 6,
                border: s.id === current ? "1px solid #f59e0b" : "1px solid #333",
                background: s.id === current ? "#f59e0b22" : "#1a1a1a",
                color: "#eee",
                cursor: "pointer",
              }}
            >
              {s.id === current ? "▶ " : "  "}
              {s.label}
            </button>
          ))}
          <button onClick={exitSession} style={{ ...btnStyle, width: "100%", marginTop: 4 }}>
            Cerrar sesión (ver login)
          </button>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} style={{ ...btnStyle, padding: "8px 12px" }}>
          🎭
        </button>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#1a1a1a",
  color: "#eee",
  border: "1px solid #333",
  borderRadius: 6,
  padding: "4px 8px",
  cursor: "pointer",
};
