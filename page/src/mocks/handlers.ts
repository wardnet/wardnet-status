import { http, HttpResponse } from "msw";
import { buildScenario, type ScenarioName } from "./scenarios";

const SCENARIOS: ScenarioName[] = [
  "operational",
  "degraded",
  "down-incident",
  "stale-config",
  "cold-start",
];

/**
 * Active scenario: ?scenario=down-incident in the URL wins, then
 * localStorage("wardnet-status-scenario"), then "operational".
 */
export function activeScenario(): ScenarioName {
  if (typeof window !== "undefined") {
    const fromUrl = new URLSearchParams(window.location.search).get("scenario");
    if (fromUrl && SCENARIOS.includes(fromUrl as ScenarioName)) {
      return fromUrl as ScenarioName;
    }
    const stored = window.localStorage?.getItem("wardnet-status-scenario");
    if (stored && SCENARIOS.includes(stored as ScenarioName)) {
      return stored as ScenarioName;
    }
  }
  return "operational";
}

export const handlers = [
  http.get("/api/status", () => HttpResponse.json(buildScenario(activeScenario()).status)),
  http.get("/api/history", () => HttpResponse.json(buildScenario(activeScenario()).history)),
  http.get("/api/incidents", () =>
    HttpResponse.json({ incidents: buildScenario(activeScenario()).incidents }),
  ),
];
