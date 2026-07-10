import { describe, expect, it, vi } from "vitest";
import { buildAlert, notifyTransition, type Transition } from "../src/notify";
import type { Env, ProbeFailure } from "../src/types";

function fail(probe: "livez" | "readyz" | "healthz"): ProbeFailure {
  return { probe, url: `https://svc.example/${probe}`, http_status: 503, latency_ms: 87, error: "HTTP 503", body: "oops" };
}

function transition(overrides: Partial<Transition> = {}): Transition {
  return {
    region: "use1",
    component: "ddns",
    regionName: "US East 1",
    componentName: "DDNS",
    from: "UP",
    to: "DOWN",
    failures: [fail("livez")],
    severity: "DOWN",
    githubUrl: "https://github.com/wardnet/wardnet-status/issues/7",
    ...overrides,
  };
}

/** Pull the single alert out of the Alertmanager payload buildAlert produces. */
function alertOf(t: Transition): any {
  return (buildAlert(t) as { alerts: any[] }).alerts[0];
}

describe("buildAlert (Alertmanager payload)", () => {
  it("DOWN fires critical, keyed region/component, following inforge's labels", () => {
    const a = alertOf(transition({ to: "DOWN", severity: "DOWN" }));
    expect(a.status).toBe("firing");
    expect(a.labels).toMatchObject({
      alertname: "wardnet-synthetic-probe",
      severity: "critical",
      service_name: "ddns",
      region: "use1",
      deployment_environment_name: "prd",
    });
    expect(a.fingerprint).toBe("use1/ddns");
    expect(a.annotations.summary).toBe("Service DDNS on US East 1 is DOWN");
    expect(a.annotations.link).toBe("https://github.com/wardnet/wardnet-status/issues/7");
  });

  it("DEGRADED fires warning", () => {
    const a = alertOf(transition({ to: "DEGRADED", severity: "DEGRADED", failures: [fail("healthz")] }));
    expect(a.status).toBe("firing");
    expect(a.labels.severity).toBe("warning");
  });

  it("holds worst severity: a DOWN→DEGRADED de-escalation still pages critical", () => {
    const a = alertOf(transition({ to: "DEGRADED", severity: "DOWN" }));
    expect(a.status).toBe("firing");
    expect(a.labels.severity).toBe("critical");
  });

  it("recovery resolves with matching labels so the alert auto-clears", () => {
    const a = alertOf(transition({ to: "UP", severity: "DOWN", failures: [], durationMs: 300_000 }));
    expect(a.status).toBe("resolved");
    // Same fingerprint + service_name as the firing alert → IRM correlates them.
    expect(a.fingerprint).toBe("use1/ddns");
    expect(a.labels.service_name).toBe("ddns");
    expect(a.annotations.summary).toContain("recovered after 5 min");
  });

  it("global components carry region=global and no region suffix in the summary", () => {
    const a = alertOf(
      transition({ region: "global", component: "tenants", regionName: "Global", componentName: "Tenants", severity: "DOWN" }),
    );
    expect(a.labels.region).toBe("global");
    expect(a.annotations.summary).toBe("Service Tenants is DOWN");
  });

  it("omits the link annotation when there is no issue URL", () => {
    const a = alertOf(transition({ githubUrl: null }));
    expect(a.annotations.link).toBeUndefined();
  });
});

describe("notifyTransition (best-effort delivery)", () => {
  const withUrl = { GRAFANA_IRM_WEBHOOK_URL: "https://irm.example/hook" } as Env;

  it("no-ops (and never calls fetch) when the webhook URL is unset", async () => {
    const fetcher = vi.fn();
    await notifyTransition({} as Env, transition(), fetcher as unknown as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("POSTs the payload to the webhook on success", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    await notifyTransition(withUrl, transition(), fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://irm.example/hook");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.alerts[0].fingerprint).toBe("use1/ddns");
    expect(body.alerts[0].labels.severity).toBe("critical");
  });

  it("gives up without retrying on a 4xx (won't improve)", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    await notifyTransition(withUrl, transition(), fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never throws when delivery fails (best-effort), retrying a bounded number of times", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      notifyTransition(withUrl, transition(), fetcher as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
