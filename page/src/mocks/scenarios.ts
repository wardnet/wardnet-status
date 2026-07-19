import type {
  DailyRow,
  HistoryResponse,
  HourlyRow,
  Incident,
  Status,
  StatusResponse,
} from "../api/types";

/**
 * Fixture scenarios for local development and component tests. Each scenario
 * is a full, consistent API surface (status + history + incidents).
 */
export type ScenarioName =
  | "operational"
  | "degraded"
  | "down-incident"
  | "stale-config"
  | "cold-start";

const PROBES = ["livez", "readyz", "healthz"] as const;
// livez is a no-op endpoint while healthz does real work, so their latencies
// differ a lot. Keyed off PROBES so history and status mocks can't drift apart.
const PROBE_LATENCY_FACTOR: Record<(typeof PROBES)[number], number> = {
  livez: 0.2,
  readyz: 1,
  healthz: 3,
};
const NOW = Date.now();

function probes(status: Status, latency = 42): StatusResponse["regions"][0]["components"][0]["probes"] {
  return PROBES.map((name) => ({
    name,
    status,
    latency_ms: status === "UNKNOWN" ? null : latency,
    checked_at: status === "UNKNOWN" ? null : NOW - 20_000,
  }));
}

function baseStatus(): StatusResponse {
  return {
    overall: "UP",
    regions: [
      {
        slug: "global",
        display_name: "Global",
        status: "UP",
        last_cycle: NOW - 20_000,
        components: [
          {
            name: "tenants",
            display_name: "Tenants (accounts & identity)",
            status: "UP",
            probes: probes("UP", 38),
          },
        ],
      },
      {
        slug: "use1",
        display_name: "US East 1",
        status: "UP",
        last_cycle: NOW - 20_000,
        components: [
          { name: "ddns", display_name: "DDNS", status: "UP", probes: probes("UP", 51) },
          { name: "tunneller", display_name: "Tunneller", status: "UP", probes: probes("UP", 64) },
          { name: "relay", display_name: "Relay", status: "UP", probes: probes("UP", 47) },
        ],
      },
      {
        slug: "euw1",
        display_name: "EU West 1",
        status: "UP",
        last_cycle: NOW - 25_000,
        components: [
          { name: "ddns", display_name: "DDNS", status: "UP", probes: probes("UP", 29) },
          { name: "tunneller", display_name: "Tunneller", status: "UP", probes: probes("UP", 33) },
          { name: "relay", display_name: "Relay", status: "UP", probes: probes("UP", 31) },
        ],
      },
      {
        slug: "apse1",
        display_name: "Asia Pacific SE 1",
        status: "UP",
        last_cycle: NOW - 15_000,
        components: [
          { name: "ddns", display_name: "DDNS", status: "UP", probes: probes("UP", 112) },
          { name: "tunneller", display_name: "Tunneller", status: "UP", probes: probes("UP", 98) },
        ],
      },
    ],
    incidents: [],
    config_stale: false,
    generated_at: NOW,
  };
}

function history(): HistoryResponse {
  const hourly: HourlyRow[] = [];
  const daily: DailyRow[] = [];
  const components: Array<[string, string]> = [
    ["global", "tenants"],
    ["use1", "ddns"],
    ["use1", "tunneller"],
    ["use1", "relay"],
    ["euw1", "ddns"],
    ["euw1", "tunneller"],
    ["euw1", "relay"],
    ["apse1", "ddns"],
    ["apse1", "tunneller"],
  ];
  for (const [region, component] of components) {
    for (let h = 48; h >= 1; h--) {
      const base = 40 + Math.round(30 * Math.abs(Math.sin(h / 5)));
      // One row per assertion, like rollup_hourly.
      for (const probe of PROBES) {
        const ms = Math.round(base * PROBE_LATENCY_FACTOR[probe]);
        hourly.push({
          hour_ts: NOW - h * 3_600_000 - (NOW % 3_600_000),
          region,
          component,
          probe,
          samples: 60,
          up: 60,
          degraded: 0,
          down: 0,
          latency_sum: ms * 60,
          latency_max: ms + 25,
        });
      }
    }
    for (let d = 90; d >= 1; d--) {
      // One row per assertion, like rollup_daily. A believable history: one
      // bad day (outage hits livez/readyz; healthz caps at degraded), and a
      // couple of degraded days surfaced through healthz only.
      for (const probe of PROBES) {
        const outage = component === "ddns" && d === 33;
        const slowSpell = component === "tunneller" && (d === 12 || d === 61);
        const down = outage && probe !== "healthz" ? 120 : 0;
        let degraded = 0;
        if (probe === "healthz" && outage) degraded = 120;
        if (probe === "healthz" && slowSpell) degraded = 45;
        const samples = 1440;
        const ms = Math.round(50 * PROBE_LATENCY_FACTOR[probe]);
        daily.push({
          day_ts: NOW - d * 86_400_000 - (NOW % 86_400_000),
          region,
          component,
          probe,
          samples,
          up: samples - down - degraded,
          degraded,
          down,
          latency_sum: ms * samples,
          latency_max: ms + 190,
        });
      }
    }
  }
  return { hourly, daily };
}

function sampleReport(component: string, status: number): string {
  return [
    "### Requests behind this evaluation",
    "",
    `#### \`readyz\` — \`https://${component}.svc.use1.prd.wardnet.network:81/readyz\``,
    "",
    `- Response code: \`HTTP ${status}\``,
    "- Latency: `4823 ms`",
    "- Response body:",
    "",
    "~~~text",
    '{"status":"unavailable","checks":{"db":"failing"}}',
    "~~~",
  ].join("\n");
}

const RESOLVED_INCIDENT: Incident = {
  id: 1,
  region: "use1",
  component: "ddns",
  severity: "DOWN",
  started_at: NOW - 33 * 86_400_000,
  escalated_at: NOW - 33 * 86_400_000 + 120_000,
  resolved_at: NOW - 33 * 86_400_000 + 7_200_000,
  probes_failing: JSON.stringify(["readyz", "livez"]),
  github_issue: 12,
  github_url: "https://github.com/wardnet/wardnet-status/issues/12",
  report: sampleReport("ddns", 503),
};

export interface Scenario {
  status: StatusResponse;
  history: HistoryResponse;
  incidents: Incident[];
}

export function buildScenario(name: ScenarioName): Scenario {
  const status = baseStatus();
  const incidents: Incident[] = [RESOLVED_INCIDENT];

  switch (name) {
    case "operational":
      break;

    case "degraded": {
      const tunneller = status.regions[1]!.components[1]!;
      tunneller.status = "DEGRADED";
      tunneller.probes = [
        { name: "livez", status: "UP", latency_ms: 40, checked_at: NOW - 20_000 },
        { name: "readyz", status: "UP", latency_ms: 45, checked_at: NOW - 20_000 },
        { name: "healthz", status: "DEGRADED", latency_ms: 1450, checked_at: NOW - 20_000 },
      ];
      status.regions[1]!.status = "DEGRADED";
      status.overall = "DEGRADED";
      status.incidents = [
        {
          id: 2,
          region: "use1",
          component: "tunneller",
          severity: "DEGRADED",
          started_at: NOW - 8 * 60_000,
          escalated_at: null,
          resolved_at: null,
          probes_failing: JSON.stringify(["healthz"]),
          github_issue: 27,
          github_url: "https://github.com/wardnet/wardnet-status/issues/27",
          report: sampleReport("tunneller", 500),
        },
      ];
      incidents.unshift(...status.incidents);
      break;
    }

    case "down-incident": {
      const ddns = status.regions[1]!.components[0]!;
      ddns.status = "DOWN";
      ddns.probes = [
        { name: "livez", status: "DOWN", latency_ms: 5000, checked_at: NOW - 20_000 },
        { name: "readyz", status: "DOWN", latency_ms: 5000, checked_at: NOW - 20_000 },
        { name: "healthz", status: "DEGRADED", latency_ms: 5000, checked_at: NOW - 20_000 },
      ];
      status.regions[1]!.status = "DOWN";
      status.overall = "DOWN";
      status.incidents = [
        {
          id: 3,
          region: "use1",
          component: "ddns",
          severity: "DOWN",
          started_at: NOW - 22 * 60_000,
          escalated_at: NOW - 20 * 60_000,
          resolved_at: null,
          probes_failing: JSON.stringify(["livez", "readyz"]),
          github_issue: 31,
          github_url: "https://github.com/wardnet/wardnet-status/issues/31",
          report: sampleReport("ddns", 503),
        },
      ];
      incidents.unshift(...status.incidents);
      break;
    }

    case "stale-config":
      status.config_stale = true;
      break;

    case "cold-start":
      for (const region of status.regions) {
        region.status = "UNKNOWN";
        region.last_cycle = null;
        for (const c of region.components) {
          c.status = "UNKNOWN";
          c.probes = probes("UNKNOWN");
        }
      }
      status.overall = "UNKNOWN";
      return { status, history: { hourly: [], daily: [] }, incidents: [] };
  }

  return { status, history: history(), incidents };
}
