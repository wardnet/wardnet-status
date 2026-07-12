import { metaGet } from "./storage";
import { parseTopology } from "./topology";
import type { Env, Status, Topology } from "./types";
import { worst } from "./types";

/**
 * JSON API consumed by the status page (and by anyone: it's public, read-only).
 *   GET /api/status    — current snapshot: regions → components → probes,
 *                        active incidents, config staleness, last probe times
 *   GET /api/history   — hourly (default 48h) and daily (default 90d) rollups
 *   GET /api/incidents — incident history (most recent first, max 100)
 *
 * The read path never fetches topology from the network: it serves the
 * last-known-good copy the prober cron maintains in D1, and the staleness
 * flag the cron writes — one cache, one staleness view.
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

  try {
    switch (url.pathname) {
      case "/api/status":
        return json(await getStatus(env));
      case "/api/history":
        return json(await getHistory(env, url.searchParams));
      case "/api/incidents":
        return json(await getIncidents(env));
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (err) {
    console.error("api error:", err);
    return json({ error: "internal error" }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=15",
    },
  });
}

/** Clamp an untrusted integer query param into [1, max]; garbage → fallback. */
export function intParam(value: string | null, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

// Module-level parse cache: the YAML only changes when the cron stores a new
// copy, so re-parsing per request is pure CPU waste.
let parsedCache: { yamlText: string; topology: Topology } | null = null;

async function loadCachedTopology(db: D1Database): Promise<Topology | null> {
  const raw = await metaGet(db, "topology:last-good");
  if (raw === undefined) return null;
  const cached = JSON.parse(raw) as { yamlText: string };
  if (parsedCache?.yamlText !== cached.yamlText) {
    parsedCache = { yamlText: cached.yamlText, topology: parseTopology(cached.yamlText) };
  }
  return parsedCache.topology;
}

interface SnapshotRow {
  region: string;
  component: string;
  probe: string;
  status: Status;
  latency_ms: number | null;
  checked_at: number;
}

async function getStatus(env: Env) {
  // Topology gives ordering/display names; D1 snapshot gives live state.
  const [topo, staleFlag, snapshot, openIncidents, metaRows] = await Promise.all([
    loadCachedTopology(env.DB).catch(() => null),
    metaGet(env.DB, "topology:stale"),
    env.DB.prepare("SELECT * FROM status_snapshot").all<SnapshotRow>(),
    env.DB
      .prepare("SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY started_at DESC")
      .all(),
    env.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'last_cycle:%'").all<{
      key: string;
      value: string;
    }>(),
  ]);

  const byKey = new Map(
    snapshot.results.map((r) => [`${r.region}/${r.component}/${r.probe}`, r]),
  );
  const lastCycle = Object.fromEntries(
    metaRows.results.map((r) => [r.key.slice("last_cycle:".length), Number(r.value)]),
  );

  const regions = (topo?.regions ?? []).map((region) => {
    const components = region.components.map((component) => {
      const probes = Object.entries(component.probes).map(([name]) => {
        const row = byKey.get(`${region.slug}/${component.name}/${name}`);
        return {
          name,
          status: (row?.status ?? "UNKNOWN") as Status,
          latency_ms: row?.latency_ms ?? null,
          checked_at: row?.checked_at ?? null,
        };
      });
      return {
        name: component.name,
        display_name: component.display_name,
        status: worst(probes.map((p) => p.status)),
        probes,
      };
    });
    return {
      slug: region.slug,
      display_name: region.display_name,
      status: worst(components.map((c) => c.status)),
      components,
      last_cycle: lastCycle[region.slug] ?? null,
    };
  });

  return {
    // worst([]) is UNKNOWN: no topology / no regions must never read as UP.
    overall: worst(regions.map((r) => r.status)),
    regions,
    incidents: openIncidents.results,
    // The cron's staleness verdict; missing (cron never ran) counts as stale.
    config_stale: staleFlag !== "0",
    generated_at: Date.now(),
  };
}

const DAY_MS = 86_400_000;

interface RollupCounts {
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
interface HourlyRow extends RollupCounts {
  hour_ts: number;
}
interface DailyRow extends RollupCounts {
  day_ts: number;
}

/**
 * Fold hourly rollups into per-UTC-day rollups, summing counts and taking the
 * max latency, keyed by (day, region, component, probe). Used to synthesize the
 * most recent days live from hourly, because materialized daily rows only exist
 * for days the nightly job has already processed.
 */
export function aggregateHourlyToDaily(rows: HourlyRow[]): DailyRow[] {
  const byKey = new Map<string, DailyRow>();
  for (const r of rows) {
    const day_ts = r.hour_ts - (r.hour_ts % DAY_MS);
    const key = `${day_ts}|${r.region}|${r.component}|${r.probe}`;
    const agg = byKey.get(key);
    if (!agg) {
      byKey.set(key, {
        day_ts,
        region: r.region,
        component: r.component,
        probe: r.probe,
        samples: r.samples,
        up: r.up,
        degraded: r.degraded,
        down: r.down,
        latency_sum: r.latency_sum,
        latency_max: r.latency_max,
      });
    } else {
      agg.samples += r.samples;
      agg.up += r.up;
      agg.degraded += r.degraded;
      agg.down += r.down;
      agg.latency_sum += r.latency_sum;
      agg.latency_max = Math.max(agg.latency_max, r.latency_max);
    }
  }
  return [...byKey.values()];
}

async function getHistory(env: Env, params: URLSearchParams, now = Date.now()) {
  const hourlyHours = intParam(params.get("hours"), 48, 24 * 14);
  const dailyDays = intParam(params.get("days"), 90, 365);
  const todayStart = now - (now % DAY_MS);
  // The nightly job materializes a completed day's rollup_daily row only at
  // 03:17 UTC. So between 00:00 and that run, YESTERDAY has no daily row yet —
  // and if we only synthesize *today*, yesterday's outages vanish from the
  // uptime bar (it reads daily rows). Synthesize today AND yesterday from
  // hourly, and exclude both from the materialized query so a later backfill
  // can't double-count them.
  const yesterdayStart = todayStart - DAY_MS;

  const [hourly, daily, recent] = await Promise.all([
    env.DB
      .prepare("SELECT * FROM rollup_hourly WHERE hour_ts >= ? ORDER BY hour_ts")
      .bind(now - hourlyHours * 3_600_000)
      .all<HourlyRow>(),
    env.DB
      .prepare("SELECT * FROM rollup_daily WHERE day_ts >= ? AND day_ts < ? ORDER BY day_ts")
      .bind(now - dailyDays * DAY_MS, yesterdayStart)
      .all<DailyRow>(),
    env.DB
      .prepare("SELECT * FROM rollup_hourly WHERE hour_ts >= ? ORDER BY hour_ts")
      .bind(yesterdayStart)
      .all<HourlyRow>(),
  ]);
  const synthesized = aggregateHourlyToDaily(recent.results);
  return { hourly: hourly.results, daily: [...daily.results, ...synthesized] };
}

async function getIncidents(env: Env) {
  const rows = await env.DB
    .prepare("SELECT * FROM incidents ORDER BY started_at DESC LIMIT 100")
    .all();
  return { incidents: rows.results };
}
