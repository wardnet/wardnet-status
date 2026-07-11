export type Status = "UP" | "DEGRADED" | "DOWN" | "UNKNOWN";
export type ProbeName = "livez" | "readyz" | "healthz";

export interface ProbeStatus {
  name: ProbeName | string;
  status: Status;
  latency_ms: number | null;
  checked_at: number | null;
}

export interface ComponentStatus {
  name: string;
  display_name: string;
  status: Status;
  probes: ProbeStatus[];
}

export interface RegionStatus {
  slug: string;
  display_name: string;
  status: Status;
  components: ComponentStatus[];
  last_cycle: number | null;
}

export interface Incident {
  id: number;
  region: string;
  component: string;
  severity: "DEGRADED" | "DOWN";
  started_at: number;
  escalated_at: number | null;
  resolved_at: number | null;
  /** JSON-encoded array of probe names. */
  probes_failing: string;
  github_issue: number | null;
  /** html_url of the GitHub issue, stored at creation time. */
  github_url: string | null;
  /** Markdown description of the requests behind the evaluation (same text as the GitHub issue). */
  report: string | null;
}

export interface StatusResponse {
  overall: Status;
  regions: RegionStatus[];
  incidents: Incident[];
  config_stale: boolean;
  generated_at: number;
}

export interface RollupRow {
  region: string;
  component: string;
  probe: string;
  samples: number;
  up: number;
  degraded: number;
  down: number;
  latency_sum: number;
  latency_max: number;
}

export interface HourlyRow extends RollupRow {
  hour_ts: number;
}

export interface DailyRow extends RollupRow {
  day_ts: number;
}

export interface HistoryResponse {
  hourly: HourlyRow[];
  daily: DailyRow[];
}

export interface IncidentsResponse {
  incidents: Incident[];
}
