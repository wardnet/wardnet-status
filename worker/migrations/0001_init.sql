-- wardnet-status initial schema.
-- Region "global" is the pseudo-region for global components (tenants).

-- Raw probe results: one row per probe per cycle. Retained 14 days (nightly prune).
CREATE TABLE probe_results (
  ts INTEGER NOT NULL,              -- epoch ms of the probe
  region TEXT NOT NULL,
  component TEXT NOT NULL,
  probe TEXT NOT NULL,              -- livez | readyz | healthz
  ok INTEGER NOT NULL,              -- 1 = 2xx within timeout
  slow INTEGER NOT NULL DEFAULT 0,  -- 1 = ok but latency > degraded_latency_ms
  http_status INTEGER,              -- NULL on network error/timeout
  latency_ms INTEGER,
  error TEXT                        -- short error string on failure
);
CREATE INDEX idx_probe_results_lookup ON probe_results (region, component, probe, ts);
CREATE INDEX idx_probe_results_ts ON probe_results (ts);

-- Current state per probe: the ladder output the API serves. One row per probe.
CREATE TABLE status_snapshot (
  region TEXT NOT NULL,
  component TEXT NOT NULL,
  probe TEXT NOT NULL,
  status TEXT NOT NULL,             -- UP | DEGRADED | DOWN | UNKNOWN
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_slow INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  checked_at INTEGER NOT NULL,      -- epoch ms of last evaluation
  PRIMARY KEY (region, component, probe)
);

-- Hourly rollups: drive charts + 90d uptime. Retained 90 days.
CREATE TABLE rollup_hourly (
  hour_ts INTEGER NOT NULL,         -- epoch ms truncated to the hour
  region TEXT NOT NULL,
  component TEXT NOT NULL,
  probe TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  up INTEGER NOT NULL DEFAULT 0,    -- sample counts per evaluated status
  degraded INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_ts, region, component, probe)
);

-- Daily rollups: uptime bars forever. Never pruned.
CREATE TABLE rollup_daily (
  day_ts INTEGER NOT NULL,          -- epoch ms truncated to UTC midnight
  region TEXT NOT NULL,
  component TEXT NOT NULL,
  probe TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  up INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_max INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_ts, region, component, probe)
);

-- Incidents: one per episode (UP→…→UP arc of a component). Never pruned.
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region TEXT NOT NULL,
  component TEXT NOT NULL,
  severity TEXT NOT NULL,           -- DEGRADED | DOWN (worst reached so far)
  started_at INTEGER NOT NULL,      -- epoch ms: entered DEGRADED/DOWN
  escalated_at INTEGER,             -- epoch ms: first reached DOWN (NULL if never)
  resolved_at INTEGER,              -- epoch ms: returned to UP (NULL while open)
  probes_failing TEXT NOT NULL,     -- JSON array of probe names involved
  github_issue INTEGER              -- issue number in GITHUB_REPO (NULL if creation failed)
);
CREATE INDEX idx_incidents_component ON incidents (region, component, started_at);
-- UNIQUE: at most one open incident per (region, component) — the episode
-- invariant, enforced even if two cycles ever race.
CREATE UNIQUE INDEX idx_incidents_one_open ON incidents (region, component) WHERE resolved_at IS NULL;

-- Operational metadata: topology etag/staleness, last cycle timestamps per region.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
