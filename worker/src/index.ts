import { handleApi } from "./api";
import { DEMO_TOPOLOGY_YAML } from "./demo-topology";
import { d1TopologyStorage, metaUpsert } from "./storage";
import { fetchTopology } from "./topology";
import type { Env } from "./types";

export { RegionProber } from "./region-prober";

// These literals MUST match worker/wrangler.jsonc `triggers.crons`. The probe
// cron is matched explicitly; anything else runs maintenance — so retuning the
// maintenance schedule in wrangler.jsonc alone degrades to a logged warning,
// never to double probing or silently-disabled pruning.
const PROBE_CRON = "* * * * *";
const MAINTENANCE_CRON = "17 3 * * *";

const RAW_RETENTION_MS = 14 * 86_400_000;
const HOURLY_RETENTION_MS = 90 * 86_400_000;
const DAY_MS = 86_400_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    // Everything else is the status page (Workers static assets, SPA fallback).
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === PROBE_CRON) {
      ctx.waitUntil(probeAllRegions(env));
      return;
    }
    if (event.cron !== MAINTENANCE_CRON) {
      console.warn(`unknown cron "${event.cron}" — running maintenance; align index.ts with wrangler.jsonc`);
    }
    ctx.waitUntil(maintain(env));
  },
} satisfies ExportedHandler<Env>;

/** Every minute: fetch the Topology Config, fan one cycle out to each region's DO. */
async function probeAllRegions(env: Env): Promise<void> {
  // TOPOLOGY_URL=demo (local dev, .dev.vars): serve the bundled demo topology
  // instead of fetching from GitHub — the cache/staleness path stays identical.
  const demo = env.TOPOLOGY_URL === "demo";
  const { topology, stale } = await fetchTopology(
    demo ? "https://demo.invalid/topology.yaml" : env.TOPOLOGY_URL,
    d1TopologyStorage(env.DB),
    demo ? async () => new Response(DEMO_TOPOLOGY_YAML) : fetch,
  );
  await metaUpsert(env.DB, "topology:stale", stale ? "1" : "0").run();

  const settled = await Promise.allSettled(
    topology.regions.map(async (region) => {
      const id = env.REGION_PROBER.idFromName(region.slug);
      const stub = env.REGION_PROBER.get(
        id,
        region.location_hint
          ? { locationHint: region.location_hint as DurableObjectLocationHint }
          : undefined,
      );
      const res = await stub.fetch("https://prober/cycle", {
        method: "POST",
        body: JSON.stringify({ region }),
        headers: { "content-type": "application/json" },
      });
      // 409 = previous cycle still running; that cycle's mutex dropped this one.
      if (!res.ok && res.status !== 409) {
        console.error(`cycle ${region.slug}: HTTP ${res.status}`);
      }
    }),
  );
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`cycle ${topology.regions[i]?.slug ?? i} failed:`, result.reason);
    }
  });
}

/**
 * Nightly maintenance: derive daily rollups from hourly (previous two days,
 * idempotent replace), then enforce tiered retention (raw 14d, hourly 90d;
 * daily + incidents forever).
 */
async function maintain(env: Env): Promise<void> {
  const now = Date.now();
  const todayStart = now - (now % DAY_MS);
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO rollup_daily (day_ts, region, component, probe, samples, up, degraded, down, latency_sum, latency_max)
         SELECT hour_ts - (hour_ts % ${DAY_MS}), region, component, probe,
                SUM(samples), SUM(up), SUM(degraded), SUM(down), SUM(latency_sum), MAX(latency_max)
         FROM rollup_hourly
         WHERE hour_ts >= ? AND hour_ts < ?
         GROUP BY 1, region, component, probe
         ON CONFLICT DO UPDATE SET
           samples = excluded.samples,
           up = excluded.up,
           degraded = excluded.degraded,
           down = excluded.down,
           latency_sum = excluded.latency_sum,
           latency_max = excluded.latency_max`,
      )
      .bind(todayStart - 2 * DAY_MS, todayStart),
    env.DB.prepare("DELETE FROM probe_results WHERE ts < ?").bind(now - RAW_RETENTION_MS),
    env.DB.prepare("DELETE FROM rollup_hourly WHERE hour_ts < ?").bind(now - HOURLY_RETENTION_MS),
  ]);
}
