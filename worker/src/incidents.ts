import type { Env, Status } from "./types";

/**
 * Incident lifecycle (see CONTEXT.md "Incident"): one incident per episode,
 * opened on entering DEGRADED, escalated in place on DOWN, resolved on UP.
 * Re-entering within REOPEN_WINDOW_MS of resolution re-opens the previous
 * incident instead of creating a new one (flap-noise cap).
 * Materialized as a D1 row (drives the page) + a GitHub issue (discussion,
 * labels, post-mortem). GitHub failures never break the cycle.
 */

export const REOPEN_WINDOW_MS = 10 * 60_000;

interface IncidentRow {
  id: number;
  severity: string;
  started_at: number;
  escalated_at: number | null;
  resolved_at: number | null;
  probes_failing: string;
  github_issue: number | null;
}

async function openIncidentRow(
  db: D1Database,
  region: string,
  component: string,
): Promise<IncidentRow | null> {
  return db
    .prepare(
      "SELECT * FROM incidents WHERE region = ? AND component = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .bind(region, component)
    .first<IncidentRow>();
}

export async function onComponentTransition(
  env: Env,
  now: number,
  region: string,
  component: string,
  from: Status,
  to: Status,
  probesFailing: string[],
): Promise<{ durationMs?: number; resolved?: boolean }> {
  const db = env.DB;
  const open = await openIncidentRow(db, region, component);

  if (to === "DEGRADED" || to === "DOWN") {
    if (open) {
      // Escalation (or de-escalation DOWN→DEGRADED, which keeps worst severity).
      if (to === "DOWN" && open.severity !== "DOWN") {
        await db
          .prepare("UPDATE incidents SET severity = 'DOWN', escalated_at = ?, probes_failing = ? WHERE id = ?")
          .bind(now, JSON.stringify(probesFailing), open.id)
          .run();
        await githubComment(env, open.github_issue, `Escalated to **DOWN** at ${iso(now)}. Failing probes: ${probesFailing.join(", ")}.`);
        await githubSetLabels(env, open.github_issue, ["incident", "down"]);
      } else {
        await db
          .prepare("UPDATE incidents SET probes_failing = ? WHERE id = ?")
          .bind(JSON.stringify(probesFailing), open.id)
          .run();
      }
      return {};
    }

    // Re-open window: a fresh episode within 10 min continues the previous one.
    const recent = await db
      .prepare(
        "SELECT * FROM incidents WHERE region = ? AND component = ? AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 1",
      )
      .bind(region, component, now - REOPEN_WINDOW_MS)
      .first<IncidentRow>();
    if (recent) {
      const severity = to === "DOWN" || recent.severity === "DOWN" ? "DOWN" : "DEGRADED";
      // A re-open that lands on DOWN is an escalation for a row that never
      // reached DOWN before — stamp escalated_at so timelines stay truthful.
      const escalatedAt =
        recent.escalated_at ?? (to === "DOWN" ? now : null);
      await db
        .prepare("UPDATE incidents SET resolved_at = NULL, severity = ?, probes_failing = ?, escalated_at = ? WHERE id = ?")
        .bind(severity, JSON.stringify(probesFailing), escalatedAt, recent.id)
        .run();
      await githubReopen(env, recent.github_issue, `Re-opened: ${component} entered ${to} again at ${iso(now)} (within the ${REOPEN_WINDOW_MS / 60_000}-minute re-open window).`);
      await githubSetLabels(env, recent.github_issue, ["incident", severity.toLowerCase()]);
      return {};
    }

    // New incident.
    const issue = await githubOpenIssue(env, region, component, to, probesFailing, now);
    await db
      .prepare(
        "INSERT INTO incidents (region, component, severity, started_at, escalated_at, probes_failing, github_issue) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(region, component, to, now, to === "DOWN" ? now : null, JSON.stringify(probesFailing), issue)
      .run();
    return {};
  }

  if (to === "UP" && open) {
    await db
      .prepare("UPDATE incidents SET resolved_at = ? WHERE id = ?")
      .bind(now, open.id)
      .run();
    const durationMs = now - open.started_at;
    const timeline = [
      `**Resolved** at ${iso(now)} — duration ${Math.round(durationMs / 60_000)} min.`,
      `- Started (DEGRADED): ${iso(open.started_at)}`,
      open.escalated_at ? `- Escalated (DOWN): ${iso(open.escalated_at)}` : null,
      `- Failing probes: ${JSON.parse(open.probes_failing).join(", ") || "n/a"}`,
    ]
      .filter(Boolean)
      .join("\n");
    await githubComment(env, open.github_issue, timeline);
    await githubClose(env, open.github_issue);
    return { durationMs, resolved: true };
  }

  return {};
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// --- GitHub issue plumbing (best-effort; failures are logged, never thrown) ---

async function gh(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | null> {
  if (!env.GH_ISSUES_TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.GH_ISSUES_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "wardnet-status",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A hung GitHub call must never stall the probe cycle into the next tick.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`github ${method} ${path}: HTTP ${res.status}`);
    return res;
  } catch (err) {
    console.error(`github ${method} ${path}:`, err);
    return null;
  }
}

async function githubOpenIssue(
  env: Env,
  region: string,
  component: string,
  severity: Status,
  probesFailing: string[],
  now: number,
): Promise<number | null> {
  const where = region === "global" ? component : `${component} (${region})`;
  const res = await gh(env, "POST", "/issues", {
    title: `[incident] ${where} is ${severity}`,
    body: [
      `**${where}** entered **${severity}** at ${iso(now)}.`,
      ``,
      `- Region: \`${region}\``,
      `- Component: \`${component}\``,
      `- Failing probes: ${probesFailing.map((p) => `\`${p}\``).join(", ") || "n/a"}`,
      ``,
      `_Opened automatically by wardnet-status; it will be closed when the component recovers._`,
    ].join("\n"),
    labels: ["incident", severity.toLowerCase()],
  });
  if (!res?.ok) return null;
  const issue = (await res.json()) as { number: number };
  return issue.number;
}

async function githubComment(env: Env, issue: number | null, body: string): Promise<void> {
  if (issue == null) return;
  await gh(env, "POST", `/issues/${issue}/comments`, { body });
}

async function githubClose(env: Env, issue: number | null): Promise<void> {
  if (issue == null) return;
  await gh(env, "PATCH", `/issues/${issue}`, { state: "closed", state_reason: "completed" });
}

async function githubReopen(env: Env, issue: number | null, comment: string): Promise<void> {
  if (issue == null) return;
  await gh(env, "PATCH", `/issues/${issue}`, { state: "open" });
  await githubComment(env, issue, comment);
}

async function githubSetLabels(env: Env, issue: number | null, labels: string[]): Promise<void> {
  if (issue == null) return;
  await gh(env, "PUT", `/issues/${issue}/labels`, { labels });
}
