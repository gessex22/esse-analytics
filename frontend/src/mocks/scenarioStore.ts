import { DEFAULT_SCENARIO, Scenario, ScenarioId, SCENARIOS } from "./scenarios";

const KEY = "esse_mock_scenario";

export function getCurrentScenarioId(): ScenarioId {
  const saved = localStorage.getItem(KEY) as ScenarioId | null;
  return saved && saved in SCENARIOS ? saved : DEFAULT_SCENARIO;
}

export function getCurrentScenario(): Scenario {
  return SCENARIOS[getCurrentScenarioId()];
}

export function setCurrentScenario(id: ScenarioId): void {
  localStorage.setItem(KEY, id);
}
