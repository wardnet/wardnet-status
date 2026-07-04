export type ProbeName = "livez" | "readyz" | "healthz";
export type Status = "UP" | "DEGRADED" | "DOWN" | "UNKNOWN";

export const SEVERITY: Record<Status, number> = {
  UP: 0,
  UNKNOWN: 1,
  DEGRADED: 2,
  DOWN: 3,
};

export function worst(statuses: Status[]): Status {
  // No inputs = no knowledge: an empty list must never read as "all clear".
  if (statuses.length === 0) return "UNKNOWN";
  return statuses.reduce<Status>(
    (acc, s) => (SEVERITY[s] > SEVERITY[acc] ? s : acc),
    "UP",
  );
}

export interface ProbeSpec {
  url: string;
  timeout_ms: number;
  degraded_latency_ms: number;
  failures_to_degraded: number;
  failures_to_down: number;
  successes_to_up: number;
}

export interface ComponentSpec {
  name: string;
  display_name: string;
  probes: Partial<Record<ProbeName, ProbeSpec>>;
}

export interface RegionSpec {
  /** "global" for the global pseudo-region. */
  slug: string;
  display_name: string;
  location_hint: string | undefined;
  components: ComponentSpec[];
}

export interface Topology {
  regions: RegionSpec[];
}

export interface Env {
  DB: D1Database;
  REGION_PROBER: DurableObjectNamespace;
  ASSETS: Fetcher;
  TOPOLOGY_URL: string;
  GITHUB_REPO: string;
  TELEGRAM_CHAT_ID: string;
  // Secrets
  TELEGRAM_BOT_TOKEN?: string;
  NTFY_TOPIC?: string;
  GH_ISSUES_TOKEN?: string;
  HEALTHCHECKS_PING_URL?: string;
}
