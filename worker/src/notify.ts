import type { Env, Status } from "./types";

export interface Transition {
  region: string;
  component: string;
  from: Status;
  to: Status;
  probesFailing: string[];
  /** Set on recovery: episode duration in ms. */
  durationMs?: number;
}

function describe(t: Transition): { title: string; body: string; priority: "warning" | "critical" | "resolved" } {
  const where = t.region === "global" ? t.component : `${t.component} (${t.region})`;
  if (t.to === "UP") {
    const mins = t.durationMs ? Math.round(t.durationMs / 60_000) : null;
    return {
      title: `RESOLVED: ${where} is back up`,
      body: mins !== null ? `Recovered after ${mins} min.` : "Recovered.",
      priority: "resolved",
    };
  }
  if (t.to === "DOWN") {
    return {
      title: `DOWN: ${where}`,
      body: `Failing probes: ${t.probesFailing.join(", ") || "unknown"}.`,
      priority: "critical",
    };
  }
  return {
    title: `DEGRADED: ${where}`,
    body: `Affected probes: ${t.probesFailing.join(", ") || "unknown"}.`,
    priority: "warning",
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
