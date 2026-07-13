import { announcementFor, evaluate, INITIAL_STATE, type ProbeState } from "./evaluator";
import { onComponentTransition } from "./incidents";
import { notifyTransition } from "./notify";
import { executeProbe, type ProbeResult } from "./prober";
import { metaUpsert } from "./storage";
import type { Env, ProbeFailure, RegionSpec, Status } from "./types";
import { worst } from "./types";

/**
 * One RegionProber per region (plus "global"), created with a locationHint so
 * probes originate near the region (best-effort). The cron handler drives it:
 * every minute it POSTs the region's slice of the Topology Config to /cycle.
 *
 * State ownership:
 * - Ladder state (per probe) lives in DO storage — advanced exactly once per
 *   sample, immediately after evaluation.
 * - Announced status (per component) also lives in DO storage but is advanced
 *   ONLY after incident + notification side effects succeed, making
 *   announcement delivery at-least-once: a failed side effect retries on the
 *   next cycle instead of being lost.
 * - Results, snapshots, rollups, and incidents land in D1 for the API.
 */
export class RegionProber implements DurableObject {
  /** Cycles never overlap: a cycle still in flight drops the next trigger. */
  private running = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/cycle") {
      if (this.running) {
        return new Response("cycle already in progress", { status: 409 });
      }
      this.running = true;
      try {
        const body = (await request.json()) as { region: RegionSpec };
        await this.runCycle(body.region);
      } finally {
        this.running = false;
      }
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  private async runCycle(region: RegionSpec): Promise<void> {
    const now = Date.now();
    const db = this.env.DB;

    // Execute all assertions of the region concurrently.
    const jobs: Array<{ component: string; probe: string; promise: Promise<ProbeResult> }> = [];
    for (const component of region.components) {
      for (const assertion of component.assertions) {
        jobs.push({ component: component.name, probe: assertion.name, promise: executeProbe(assertion) });
      }
    }
    const results = new Map<string, ProbeResult>();
    await Promise.all(
      jobs.map(async (j) => {
        results.set(`${j.component}/${j.probe}`, await j.promise);
      }),
    );

    // Batched DO storage reads: all ladder states + all announced statuses.
    const ladderKeys = jobs.map((j) => `ladder:${j.component}:${j.probe}`);
    const announcedKeys = region.components.map((c) => `announced:${c.name}`);
    const stored = await this.state.storage.get([...ladderKeys, ...announcedKeys]);

    // Evaluate ladders, collect component statuses and D1 statements.
    const nextComponent = new Map<string, Status>();
    const failingProbes = new Map<string, ProbeFailure[]>();
    const newLadders: Record<string, ProbeState> = {};
    const statements: D1PreparedStatement[] = [];

    for (const component of region.components) {
      const perProbeNext: Status[] = [];
      const failing: ProbeFailure[] = [];

      for (const spec of component.assertions) {
        const probe = spec.name;
        const r = results.get(`${component.name}/${probe}`)!;

        const key = `ladder:${component.name}:${probe}`;
        const prev = (stored.get(key) as ProbeState | undefined) ?? INITIAL_STATE;
        const next = evaluate(prev, { ok: r.ok, slow: r.slow }, spec);
        newLadders[key] = next;

        // One line per assertion request — the debugging trail for every cycle
        // (visible in `wrangler dev` locally, `wrangler tail` in production).
        console.log(
          `probe ${region.slug}/${component.name}/${probe} ${spec.url} → ` +
            `${r.httpStatus !== null ? `HTTP ${r.httpStatus}` : (r.error ?? "no response")} ` +
            `${r.latencyMs}ms${r.slow ? " (slow)" : ""} ⇒ ${next.status}` +
            (next.consecutiveFailures > 0 ? ` (${next.consecutiveFailures} consecutive failures)` : ""),
        );

        perProbeNext.push(next.status);
        if (next.status !== "UP" && next.status !== "UNKNOWN") {
          failing.push({
            probe,
            url: spec.url,
            http_status: r.httpStatus,
            latency_ms: r.latencyMs,
            error: r.error,
            body: r.bodySnippet,
          });
        }

        // Raw rows are for debugging incidents, not steady state: writing them
        // only when something is off keeps D1 row-writes far under the free cap.
        if (!r.ok || r.slow || next.status !== "UP") {
          statements.push(
            db
              .prepare(
                "INSERT INTO probe_results (ts, region, component, probe, ok, slow, http_status, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .bind(now, region.slug, component.name, probe, r.ok ? 1 : 0, r.slow ? 1 : 0, r.httpStatus, r.latencyMs, r.error),
          );
        }
        statements.push(
          db
            .prepare(
              `INSERT INTO status_snapshot (region, component, probe, status, consecutive_failures, consecutive_slow, latency_ms, checked_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (region, component, probe) DO UPDATE SET
                 status = excluded.status,
                 consecutive_failures = excluded.consecutive_failures,
                 consecutive_slow = excluded.consecutive_slow,
                 latency_ms = excluded.latency_ms,
                 checked_at = excluded.checked_at`,
            )
            .bind(region.slug, component.name, probe, next.status, next.consecutiveFailures, next.consecutiveSlow, r.latencyMs, now),
          // Hourly rollup only — daily is derived from hourly by the nightly
          // maintenance cron (and synthesized for today by the API).
          hourlyRollup(db, now, region.slug, component.name, probe, next.status, r.latencyMs),
        );
      }

      nextComponent.set(component.name, worst(perProbeNext));
      failingProbes.set(component.name, failing);
    }

    statements.push(metaUpsert(db, `last_cycle:${region.slug}`, String(now)));

    // Ladder state advances exactly once per sample; announced state does not.
    await this.state.storage.put(newLadders);
    await db.batch(statements);

    // Announcements: compare against the last ANNOUNCED status and advance it
    // only after side effects succeed (at-least-once). Per-component isolation:
    // one component's failure never blocks another's announcement.
    let cycleOk = true;
    for (const component of region.components) {
      const current = nextComponent.get(component.name)!;
      const announced = stored.get(`announced:${component.name}`) as Status | undefined;
      const action = announcementFor(announced, current);
      if (action === "skip") continue;

      try {
        const ref = {
          region: region.slug,
          component: component.name,
          regionName: region.display_name,
          componentName: component.display_name,
        };
        const { durationMs, resolved, severity, githubUrl } = await onComponentTransition(
          this.env,
          now,
          ref,
          announced ?? "UNKNOWN",
          current,
          failingProbes.get(component.name) ?? [],
        );
        // "reconcile" adopts UP silently on cold start — unless a stale open
        // incident was actually resolved, which deserves its notification.
        if (action === "announce" || resolved) {
          await notifyTransition(this.env, {
            ...ref,
            from: announced ?? "UNKNOWN",
            to: current,
            failures: failingProbes.get(component.name) ?? [],
            severity,
            githubUrl,
            durationMs,
          });
        }
        await this.state.storage.put(`announced:${component.name}`, current);
      } catch (err) {
        cycleOk = false;
        console.error(`announce ${region.slug}/${component.name} ${announced}→${current}:`, err);
      }
    }

    // Dead-man's switch: ping healthchecks.io only after a fully successful cycle.
    if (cycleOk && this.env.HEALTHCHECKS_PING_URL) {
      try {
        await fetch(`${this.env.HEALTHCHECKS_PING_URL}/${region.slug}`, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        console.error("healthchecks ping failed:", err);
      }
    }
  }
}

function hourlyRollup(
  db: D1Database,
  now: number,
  region: string,
  component: string,
  probe: string,
  status: Status,
  latencyMs: number,
): D1PreparedStatement {
  const hour = now - (now % 3_600_000);
  return db
    .prepare(
      `INSERT INTO rollup_hourly (hour_ts, region, component, probe, samples, up, degraded, down, latency_sum, latency_max)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET
         samples = samples + 1,
         up = up + excluded.up,
         degraded = degraded + excluded.degraded,
         down = down + excluded.down,
         latency_sum = latency_sum + excluded.latency_sum,
         latency_max = MAX(latency_max, excluded.latency_max)`,
    )
    .bind(
      hour,
      region,
      component,
      probe,
      status === "UP" ? 1 : 0,
      status === "DEGRADED" ? 1 : 0,
      status === "DOWN" ? 1 : 0,
      latencyMs,
      latencyMs,
    );
}
