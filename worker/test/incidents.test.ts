import { beforeEach, describe, expect, it } from "vitest";
import { onComponentTransition, REOPEN_WINDOW_MS } from "../src/incidents";
import type { Env } from "../src/types";

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
          const [region, component, severity, started_at, escalated_at, probes_failing, github_issue] =
            args as [string, string, string, number, number | null, string, number | null];
          rows.push({ id: nextId++, region, component, severity, started_at, escalated_at, resolved_at: null, probes_failing, github_issue });
        } else if (sql.includes("SET severity = 'DOWN'")) {
          const [escalated_at, probes_failing, id] = args as [number, string, number];
          const r = rows.find((x) => x.id === id)!;
          r.severity = "DOWN";
          r.escalated_at = escalated_at;
          r.probes_failing = probes_failing;
        } else if (sql.includes("SET resolved_at = NULL")) {
          const [severity, probes_failing, escalated_at, id] = args as [string, string, number | null, number];
          const r = rows.find((x) => x.id === id)!;
          r.resolved_at = null;
          r.severity = severity;
          r.probes_failing = probes_failing;
          r.escalated_at = escalated_at;
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

describe("incident lifecycle", () => {
  let db: ReturnType<typeof fakeDb>;
  let env: Env;
  const T0 = 1_000_000_000;

  beforeEach(() => {
    db = fakeDb();
    env = envWith(db.db);
  });

  it("opens one incident on entering DEGRADED and escalates in place on DOWN", async () => {
    await onComponentTransition(env, T0, "use1", "ddns", "UP", "DEGRADED", ["readyz"]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ severity: "DEGRADED", escalated_at: null, resolved_at: null });

    await onComponentTransition(env, T0 + 60_000, "use1", "ddns", "DEGRADED", "DOWN", ["readyz", "livez"]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ severity: "DOWN", escalated_at: T0 + 60_000 });
  });

  it("resolves on UP, reports the episode duration, and flags resolved", async () => {
    await onComponentTransition(env, T0, "use1", "ddns", "UP", "DEGRADED", ["readyz"]);
    const { durationMs, resolved } = await onComponentTransition(env, T0 + 300_000, "use1", "ddns", "DEGRADED", "UP", []);
    expect(db.rows[0]!.resolved_at).toBe(T0 + 300_000);
    expect(durationMs).toBe(300_000);
    expect(resolved).toBe(true);
  });

  it("UP with no open incident resolves nothing (cold-start reconcile is a no-op)", async () => {
    const { resolved } = await onComponentTransition(env, T0, "use1", "ddns", "UNKNOWN", "UP", []);
    expect(resolved).toBeUndefined();
    expect(db.rows).toHaveLength(0);
  });

  it("re-open that escalates to DOWN stamps escalated_at", async () => {
    await onComponentTransition(env, T0, "use1", "ddns", "UP", "DEGRADED", ["readyz"]);
    await onComponentTransition(env, T0 + 60_000, "use1", "ddns", "DEGRADED", "UP", []);
    expect(db.rows[0]!.escalated_at).toBeNull();
    await onComponentTransition(env, T0 + 120_000, "use1", "ddns", "UP", "DOWN", ["livez"]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ severity: "DOWN", escalated_at: T0 + 120_000, resolved_at: null });
  });

  it("re-opens the previous incident within the re-open window", async () => {
    await onComponentTransition(env, T0, "use1", "ddns", "UP", "DOWN", ["livez"]);
    await onComponentTransition(env, T0 + 60_000, "use1", "ddns", "DOWN", "UP", []);
    await onComponentTransition(env, T0 + 60_000 + REOPEN_WINDOW_MS - 1, "use1", "ddns", "UP", "DEGRADED", ["healthz"]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ resolved_at: null, severity: "DOWN" }); // keeps worst severity
  });

  it("creates a new incident after the re-open window has passed", async () => {
    await onComponentTransition(env, T0, "use1", "ddns", "UP", "DEGRADED", ["readyz"]);
    await onComponentTransition(env, T0 + 60_000, "use1", "ddns", "DEGRADED", "UP", []);
    await onComponentTransition(env, T0 + 60_000 + REOPEN_WINDOW_MS + 1, "use1", "ddns", "UP", "DEGRADED", ["readyz"]);
    expect(db.rows).toHaveLength(2);
  });

  it("keeps incidents per (region, component) independent", async () => {
    await onComponentTransition(env, T0, "use1", "ddns", "UP", "DEGRADED", ["readyz"]);
    await onComponentTransition(env, T0, "global", "tenants", "UP", "DOWN", ["livez"]);
    expect(db.rows).toHaveLength(2);
    await onComponentTransition(env, T0 + 60_000, "use1", "ddns", "DEGRADED", "UP", []);
    expect(db.rows.filter((r) => r.resolved_at === null)).toHaveLength(1);
  });
});
