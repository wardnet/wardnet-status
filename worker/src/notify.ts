import { incidentTitle } from "./incidents";
import type { ComponentRef, Env, ProbeFailure, Status } from "./types";

export interface Transition extends ComponentRef {
  from: Status;
  to: Status;
  failures: ProbeFailure[];
  /** Set on recovery: episode duration in ms. */
  durationMs?: number;
}

/** One line per failing request — notifications stay short; the issue has the bodies. */
function failureLines(failures: ProbeFailure[]): string {
  if (failures.length === 0) return "No request details captured.";
  return failures
    .map((f) => {
      const code = f.http_status !== null ? `HTTP ${f.http_status}` : (f.error ?? "no response");
      return `${f.probe}: ${code} in ${f.latency_ms} ms (${f.url})`;
    })
    .join("\n");
}

function describe(t: Transition): { title: string; body: string; priority: "warning" | "critical" | "resolved" } {
  const where = t.region === "global" ? `Service ${t.componentName}` : `Service ${t.componentName} on ${t.regionName}`;
  if (t.to === "UP") {
    const mins = t.durationMs ? Math.round(t.durationMs / 60_000) : null;
    return {
      title: `RESOLVED: ${where} is back up`,
      body: mins !== null ? `Recovered after ${mins} min.` : "Recovered.",
      priority: "resolved",
    };
  }
  return {
    title: incidentTitle(t, t.to),
    body: failureLines(t.failures),
    priority: t.to === "DOWN" ? "critical" : "warning",
  };
}

/** Fire-and-log: a notification failure must never break the probe cycle. */
export async function notifyTransition(env: Env, t: Transition): Promise<void> {
  const msg = describe(t);
  await Promise.allSettled([sendTelegram(env, msg), sendNtfy(env, msg)]).then(
    (results) => {
      for (const r of results) {
        if (r.status === "rejected") console.error("notify failed:", r.reason);
      }
    },
  );
}

async function sendTelegram(
  env: Env,
  msg: { title: string; body: string },
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: `${msg.title}\n${msg.body}`,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`telegram: HTTP ${res.status}`);
}

async function sendNtfy(
  env: Env,
  msg: { title: string; body: string; priority: "warning" | "critical" | "resolved" },
): Promise<void> {
  if (!env.NTFY_TOPIC) return;
  const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      Title: msg.title,
      Priority: msg.priority === "critical" ? "urgent" : msg.priority === "warning" ? "high" : "default",
      Tags: msg.priority === "resolved" ? "white_check_mark" : "rotating_light",
    },
    body: msg.body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
}
