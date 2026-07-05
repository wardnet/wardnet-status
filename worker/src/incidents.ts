import { setIncidentFields, severityOption } from "./github-fields";
import type { ComponentRef, Env, ProbeFailure, Status } from "./types";

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

/** "Service Website on US East 1 is DOWN" (global components have no region suffix). */
export function incidentTitle(ref: ComponentRef, severity: Status): string {
  const where = ref.region === "global" ? "" : ` on ${ref.regionName}`;
  return `Service ${ref.componentName}${where} is ${severity}`;
}

/**
 * Markdown section listing every probe request that drove the evaluation:
 * path, response code, latency, and (truncated) response body.
 */
export function failureReport(failures: ProbeFailure[]): string {
  if (failures.length === 0) return "_No failing request details were captured._";
  const sections = failures.map((f) => {
    const code = f.http_status !== null ? `HTTP ${f.http_status}` : (f.error ?? "no response");
    const lines = [
      `#### \`${f.probe}\` — \`${f.url}\``,
      ``,
      `- Response code: \`${code}\``,
      `- Latency: \`${f.latency_ms} ms\``,
    ];
    if (f.body !== null && f.body !== "") {
      // ~~~ fencing: a body containing ``` must not break the issue markdown.
      lines.push(`- Response body:`, ``, `~~~text`, f.body.replaceAll("~~~", "~ ~ ~"), `~~~`);
    } else {
      lines.push(`- Response body: _empty_`);
    }
    return lines.join("\n");
  });
  return ["### Requests behind this evaluation", "", ...sections].join("\n");
}

const probeNames = (failures: ProbeFailure[]): string[] => failures.map((f) => f.probe);

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
  ref: ComponentRef,
  from: Status,
  to: Status,
  failures: ProbeFailure[],
): Promise<{ durationMs?: number; resolved?: boolean }> {
  const db = env.DB;
  const { region, component } = ref;
  const failingJson = JSON.stringify(probeNames(failures));
  const open = await openIncidentRow(db, region, component);

  if (to === "DEGRADED" || to === "DOWN") {
    if (open) {
      // Escalation (or de-escalation DOWN→DEGRADED, which keeps worst severity).
      if (to === "DOWN" && open.severity !== "DOWN") {
        await db
          .prepare("UPDATE incidents SET severity = 'DOWN', escalated_at = ?, probes_failing = ?, report = ? WHERE id = ?")
          .bind(now, failingJson, failureReport(failures), open.id)
          .run();
        await githubRetitle(env, open.github_issue, incidentTitle(ref, "DOWN"));
        await githubComment(
          env,
          open.github_issue,
          [`Escalated to **DOWN** at ${iso(now)}.`, ``, failureReport(failures)].join("\n"),
        );
        await githubSetLabels(env, open.github_issue, ["incident", "down"]);
        await setIncidentFields(env, open.github_issue, { severity: severityOption("DOWN") ?? undefined });
      } else {
        await db
          .prepare("UPDATE incidents SET probes_failing = ? WHERE id = ?")
          .bind(failingJson, open.id)
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
        .prepare("UPDATE incidents SET resolved_at = NULL, severity = ?, probes_failing = ?, escalated_at = ?, report = ? WHERE id = ?")
        .bind(severity, failingJson, escalatedAt, failureReport(failures), recent.id)
        .run();
      await githubReopen(
        env,
        recent.github_issue,
        [
          `Re-opened: ${ref.componentName} entered ${to} again at ${iso(now)} (within the ${REOPEN_WINDOW_MS / 60_000}-minute re-open window).`,
          ``,
          failureReport(failures),
        ].join("\n"),
      );
      await githubSetLabels(env, recent.github_issue, ["incident", severity.toLowerCase()]);
      await setIncidentFields(env, recent.github_issue, {
        severity: severityOption(severity as Status) ?? undefined,
        status: "Investigating",
      });
      return {};
    }

    // New incident.
    const issue = await githubOpenIssue(env, ref, to, failures, now);
    await setIncidentFields(env, issue?.number ?? null, {
      severity: severityOption(to) ?? undefined,
      status: "Investigating",
      component: ref.componentName,
      region: ref.regionName,
      detectedAt: iso(now),
    });
    await db
      .prepare(
        "INSERT INTO incidents (region, component, severity, started_at, escalated_at, probes_failing, github_issue, github_url, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(region, component, to, now, to === "DOWN" ? now : null, failingJson, issue?.number ?? null, issue?.htmlUrl ?? null, failureReport(failures))
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
    await setIncidentFields(env, open.github_issue, {
      status: "Resolved",
      downtimeMinutes: Math.round(durationMs / 60_000),
    });
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

/** Issue type (org-level) assigned by NAME; repos without it fall back to a plain issue. */
const ISSUE_TYPE = "Incident";

async function githubOpenIssue(
  env: Env,
  ref: ComponentRef,
  severity: Status,
  failures: ProbeFailure[],
  now: number,
): Promise<{ number: number; htmlUrl: string | null } | null> {
  const payload = {
    title: incidentTitle(ref, severity),
    body: [
      `**${ref.componentName}** (\`${ref.component}\`) on **${ref.regionName}** (\`${ref.region}\`) entered **${severity}** at ${iso(now)}.`,
      ``,
      failureReport(failures),
      ``,
      `_Opened automatically by wardnet-status; it will be closed when the component recovers._`,
    ].join("\n"),
    labels: ["incident", severity.toLowerCase()],
  };
  let res = await gh(env, "POST", "/issues", { ...payload, type: ISSUE_TYPE });
  if (res?.status === 422) {
    // Org/repo without the Incident issue type: a typed create is rejected
    // outright, so retry untyped rather than losing the issue.
    console.warn(`github issue type "${ISSUE_TYPE}" rejected — creating untyped issue`);
    res = await gh(env, "POST", "/issues", payload);
  }
  if (!res?.ok) return null;
  const issue = (await res.json()) as { number: number; html_url?: string };
  return { number: issue.number, htmlUrl: issue.html_url ?? null };
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

async function githubRetitle(env: Env, issue: number | null, title: string): Promise<void> {
  if (issue == null) return;
  await gh(env, "PATCH", `/issues/${issue}`, { title });
}

async function githubSetLabels(env: Env, issue: number | null, labels: string[]): Promise<void> {
  if (issue == null) return;
  await gh(env, "PUT", `/issues/${issue}/labels`, { labels });
}
