import { beforeEach, describe, expect, it } from "vitest";
import { failureReport, incidentTitle, onComponentTransition, REOPEN_WINDOW_MS } from "../src/incidents";
import type { ComponentRef, Env, ProbeFailure, ProbeName } from "../src/types";

function ref(region: string, component: string): ComponentRef {
  return { region, component, regionName: region, componentName: component };
}

function fail(probe: ProbeName): ProbeFailure {
  return { probe, url: `https://svc.example/${probe}`, http_status: 503, latency_ms: 87, error: "HTTP 503", body: "oops" };
}

const fails = (...probes: ProbeName[]): ProbeFailure[] => probes.map(fail);

/**
 * Minimal in-memory stand-in for the D1 incidents table — just enough SQL
 * pattern-matching for the incident manager's four queries.
 */
interface Row {
  id: number;
  region: string;
  component: string;
  severity: string;
  started_at: number;
  escalated_at: number | null;
  resolved_at: number | null;
  probes_failing: string;
  github_issue: number | null;
  github_url: string | null;
  report: string | null;
}

function fakeDb() {
  const rows: Row[] = [];
  let nextId = 1;

  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async <T>(): Promise<T | null> => {
        if (sql.includes("resolved_at IS NULL")) {
          const [region, component] = args as [string, string];
          const open = rows
            .filter((r) => r.region === region && r.component === component && r.resolved_at === null)
            .sort((a, b) => b.started_at - a.started_at);
          return (open[0] ?? null) as T | null;
        }
        if (sql.includes("resolved_at >= ?")) {
          const [region, component, since] = args as [string, string, number];
          const recent = rows
            .filter((r) => r.region === region && r.component === component && r.resolved_at !== null && r.resolved_at >= since)
            .sort((a, b) => b.resolved_at! - a.resolved_at!);
          return (recent[0] ?? null) as T | null;
        }
        throw new Error(`unexpected first(): ${sql}`);
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO incidents")) {
          const [region, component, severity, started_at, escalated_at, probes_failing, github_issue, github_url, report] =
            args as [string, string, string, number, number | null, string, number | null, string | null, string | null];
          rows.push({ id: nextId++, region, component, severity, started_at, escalated_at, resolved_at: null, probes_failing, github_issue, github_url, report });
        } else if (sql.includes("SET severity = 'DOWN'")) {
          const [escalated_at, probes_failing, report, id] = args as [number, string, string, number];
          const r = rows.find((x) => x.id === id)!;
          r.severity = "DOWN";
          r.escalated_at = escalated_at;
          r.probes_failing = probes_failing;
          r.report = report;
        } else if (sql.includes("SET resolved_at = NULL")) {
          const [severity, probes_failing, escalated_at, report, id] = args as [string, string, number | null, string, number];
          const r = rows.find((x) => x.id === id)!;
          r.resolved_at = null;
          r.severity = severity;
          r.probes_failing = probes_failing;
          r.escalated_at = escalated_at;
          r.report = report;
        } else if (sql.includes("SET resolved_at = ?")) {
          const [resolved_at, id] = args as [number, number];
          rows.find((x) => x.id === id)!.resolved_at = resolved_at;
        } else if (sql.includes("SET probes_failing = ?")) {
          const [probes_failing, id] = args as [string, number];
          rows.find((x) => x.id === id)!.probes_failing = probes_failing;
        } else {
          throw new Error(`unexpected run(): ${sql}`);
        }
        return { success: true };
      },
    }),
  });

  return { db: { prepare: stmt } as unknown as D1Database, rows };
}

function envWith(db: D1Database): Env {
  // No GH_ISSUES_TOKEN → GitHub calls are no-ops; we test the D1 lifecycle.
  return { DB: db, GITHUB_REPO: "wardnet/wardnet-status", TELEGRAM_CHAT_ID: "" } as Env;
}

describe("incident presentation", () => {
  it("titles incidents as 'Service <name> on <region> is <SEVERITY>'", () => {
    expect(
      incidentTitle({ region: "use1", component: "ddns", regionName: "US East 1", componentName: "DDNS" }, "DOWN"),
    ).toBe("Service DDNS on US East 1 is DOWN");
    // Global components exist once — no region suffix.
    expect(
      incidentTitle({ region: "global", component: "tenants", regionName: "Global", componentName: "Tenants" }, "DEGRADED"),
    ).toBe("Service Tenants is DEGRADED");
  });

  it("failureReport lists path, response code, latency, and body per request", () => {
    const report = failureReport(fails("readyz"));
    expect(report).toContain("https://svc.example/readyz");
    expect(report).toContain("HTTP 503");
    expect(report).toContain("87 ms");
    expect(report).toContain("oops");
  });

  it("failureReport survives timeouts (no HTTP status, no body)", () => {
    const report = failureReport([
      { probe: "livez", url: "https://svc.example/livez", http_status: null, latency_ms: 5000, error: "timeout", body: null },
    ]);
    expect(report).toContain("timeout");
    expect(report).toContain("_empty_");
  });
});

describe("incident lifecycle", () => {
  let db: ReturnType<typeof fakeDb>;
  let env: Env;
  const T0 = 1_000_000_000;

  beforeEach(() => {
    db = fakeDb();
    env = envWith(db.db);
  });

  it("opens one incident on entering DEGRADED and escalates in place on DOWN", async () => {
    await onComponentTransition(env, T0, ref("use1", "ddns"), "UP", "DEGRADED", fails("readyz"));
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ severity: "DEGRADED", escalated_at: null, resolved_at: null });
    // The stored report carries the request details the page displays.
    expect(db.rows[0]!.report).toContain("https://svc.example/readyz");

    await onComponentTransition(env, T0 + 60_000, ref("use1", "ddns"), "DEGRADED", "DOWN", fails("readyz", "livez"));
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ severity: "DOWN", escalated_at: T0 + 60_000 });
  });

  it("resolves on UP, reports the episode duration, and flags resolved", async () => {
    await onComponentTransition(env, T0, ref("use1", "ddns"), "UP", "DEGRADED", fails("readyz"));
    const { durationMs, resolved } = await onComponentTransition(env, T0 + 300_000, ref("use1", "ddns"), "DEGRADED", "UP", fails());
    expect(db.rows[0]!.resolved_at).toBe(T0 + 300_000);
    expect(durationMs).toBe(300_000);
    expect(resolved).toBe(true);
  });

  it("UP with no open incident resolves nothing (cold-start reconcile is a no-op)", async () => {
    const { resolved } = await onComponentTransition(env, T0, ref("use1", "ddns"), "UNKNOWN", "UP", fails());
    expect(resolved).toBeUndefined();
    expect(db.rows).toHaveLength(0);
  });

  it("re-open that escalates to DOWN stamps escalated_at", async () => {
    await onComponentTransition(env, T0, ref("use1", "ddns"), "UP", "DEGRADED", fails("readyz"));
    await onComponentTransition(env, T0 + 60_000, ref("use1", "ddns"), "DEGRADED", "UP", fails());
    expect(db.rows[0]!.escalated_at).toBeNull();
    await onComponentTransition(env, T0 + 120_000, ref("use1", "ddns"), "UP", "DOWN", fails("livez"));
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ severity: "DOWN", escalated_at: T0 + 120_000, resolved_at: null });
  });

  it("re-opens the previous incident within the re-open window", async () => {
    await onComponentTransition(env, T0, ref("use1", "ddns"), "UP", "DOWN", fails("livez"));
    await onComponentTransition(env, T0 + 60_000, ref("use1", "ddns"), "DOWN", "UP", fails());
    await onComponentTransition(env, T0 + 60_000 + REOPEN_WINDOW_MS - 1, ref("use1", "ddns"), "UP", "DEGRADED", fails("healthz"));
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ resolved_at: null, severity: "DOWN" }); // keeps worst severity
  });

  it("creates a new incident after the re-open window has passed", async () => {
    await onComponentTransition(env, T0, ref("use1", "ddns"), "UP", "DEGRADED", fails("readyz"));
    await onComponentTransition(env, T0 + 60_000, ref("use1", "ddns"), "DEGRADED", "UP", fails());
    await onComponentTransition(env, T0 + 60_000 + REOPEN_WINDOW_MS + 1, ref("use1", "ddns"), "UP", "DEGRADED", fails("readyz"));
    expect(db.rows).toHaveLength(2);
  });

  it("keeps incidents per (region, component) independent", async () => {
    await onComponentTransition(env, T0, ref("use1", "ddns"), "UP", "DEGRADED", fails("readyz"));
    await onComponentTransition(env, T0, ref("global", "tenants"), "UP", "DOWN", fails("livez"));
    expect(db.rows).toHaveLength(2);
    await onComponentTransition(env, T0 + 60_000, ref("use1", "ddns"), "DEGRADED", "UP", fails());
    expect(db.rows.filter((r) => r.resolved_at === null)).toHaveLength(1);
  });
});
