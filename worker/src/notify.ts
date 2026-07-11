import { incidentTitle } from "./incidents";
import type { ComponentRef, Env, ProbeFailure, Status } from "./types";

/**
 * Status transitions notify Grafana IRM (the customer-facing pager) via an
 * Alertmanager-compatible webhook — one alert per Episode, keyed by
 * `region/component`, so an escalation re-fires the same alert and recovery
 * auto-resolves it. Labels follow inforge's model (severity ∈ critical/warning,
 * service_name, region, deployment_environment_name).
 *
 * This is BEST-EFFORT and decoupled from the gated incident path: a failed page
 * never blocks the cycle or the GitHub/status-page record. It retries a few
 * times in-cycle to shrink the dropped-page window, then gives up.
 */

export interface Transition extends ComponentRef {
  from: Status;
  to: Status;
  failures: ProbeFailure[];
  /** Episode's worst-so-far severity — held across a DOWN→DEGRADED de-escalation. */
  severity?: "DEGRADED" | "DOWN";
  /** GitHub issue URL for this episode, linked from the alert. */
  githubUrl?: string | null;
  /** Set on recovery: episode duration in ms. */
  durationMs?: number;
}

// wardnet-status only monitors production; inforge's env label is `prd`.
const ENVIRONMENT = "prd";
const ALERT_NAME = "wardnet-synthetic-probe";

// inforge severity vocabulary: DOWN → critical, DEGRADED → warning.
function severityLabel(t: Transition): "critical" | "warning" {
  const worst = t.severity ?? (t.to === "UP" ? "DEGRADED" : (t.to as "DEGRADED" | "DOWN"));
  return worst === "DOWN" ? "critical" : "warning";
}

/** One line per failing request — the GitHub issue holds the full bodies. */
function failureLines(failures: ProbeFailure[]): string {
  if (failures.length === 0) return "No request details captured.";
  return failures
    .map((f) => {
      const code = f.http_status !== null ? `HTTP ${f.http_status}` : (f.error ?? "no response");
      return `${f.probe}: ${code} in ${f.latency_ms} ms (${f.url})`;
    })
    .join("\n");
}

/** Build the Alertmanager webhook payload (a single alert) for a transition. */
export function buildAlert(t: Transition): unknown {
  const firing = t.to !== "UP";
  const where = t.region === "global" ? `Service ${t.componentName}` : `Service ${t.componentName} on ${t.regionName}`;
  const mins = t.durationMs != null ? Math.round(t.durationMs / 60_000) : null;

  const annotations: Record<string, string> = {
    summary: firing ? incidentTitle(t, t.severity ?? (t.to as Status)) : `${where} recovered${mins !== null ? ` after ${mins} min` : ""}`,
    description: firing ? failureLines(t.failures) : "Component returned to UP.",
  };
  if (t.githubUrl) annotations.link = t.githubUrl;

  return {
    alerts: [
      {
        status: firing ? "firing" : "resolved",
        labels: {
          alertname: ALERT_NAME,
          severity: severityLabel(t),
          service_name: t.component,
          region: t.region,
          deployment_environment_name: ENVIRONMENT,
        },
        annotations,
        // Stable per-episode identity — the same key firing and resolving, so
        // Alertmanager/IRM correlates them into one alert group.
        fingerprint: `${t.region}/${t.component}`,
      },
    ],
  };
}

const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 4_000;
const BACKOFF_MS = 250;

/**
 * Best-effort page to Grafana IRM. Never throws — a notification failure must
 * never break the probe cycle. Retries on network/5xx (bounded), gives up on
 * 4xx (won't improve) and after ATTEMPTS.
 */
export async function notifyTransition(
  env: Env,
  t: Transition,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!env.GRAFANA_IRM_WEBHOOK_URL) return;
  const body = JSON.stringify(buildAlert(t));

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetcher(env.GRAFANA_IRM_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok) return;
      if (res.status < 500) {
        // 4xx is a bad request/URL — retrying won't help.
        console.error(`grafana irm: HTTP ${res.status}`);
        return;
      }
      console.error(`grafana irm: HTTP ${res.status} (attempt ${attempt}/${ATTEMPTS})`);
    } catch (err) {
      console.error(`grafana irm (attempt ${attempt}/${ATTEMPTS}):`, err);
    }
    if (attempt < ATTEMPTS) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
    }
  }
}
