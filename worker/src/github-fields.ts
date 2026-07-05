import type { Env, Status } from "./types";

/**
 * GitHub "Incident" issue-type custom fields, set via GraphQL.
 *
 * The contract with the org configuration is NAMES ONLY (field names and
 * single-select option names below). IDs are resolved at runtime from the
 * repository's issueFields and cached briefly — never hardcoded, so fields
 * can be recreated/reordered in the org settings without touching this code.
 * A field that doesn't exist (or an unknown option) is logged and skipped;
 * field plumbing must never break the probe cycle or issue creation.
 */

export const INCIDENT_FIELDS = {
  severity: "Severity",
  status: "Incident status",
  component: "Affected component",
  region: "Affected region",
  detectedAt: "Detected at",
  downtime: "Downtime",
} as const;

/** Maps the internal status ladder onto the org's Severity options. */
export function severityOption(status: Status): string | null {
  if (status === "DOWN") return "Full outage";
  if (status === "DEGRADED") return "Major degradation";
  return null;
}

export interface IncidentFieldValues {
  severity?: string;
  /** Investigating → Identified → Monitoring → Resolved (we set the ends). */
  status?: string;
  component?: string;
  region?: string;
  /** ISO timestamp of first detection. */
  detectedAt?: string;
  /** Total DEGRADED/DOWN time in minutes, set on resolution. */
  downtimeMinutes?: number;
}

interface IssueField {
  id: string;
  name: string;
  options?: Array<{ id: string; name: string }>;
}

async function ghGraphql(
  env: Env,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, any> | null> {
  if (!env.GH_ISSUES_TOKEN) return null;
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_ISSUES_TOKEN}`,
        "content-type": "application/json",
        "user-agent": "wardnet-status",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      data?: Record<string, any>;
      errors?: Array<{ message: string }>;
    };
    if (!res.ok || body.errors?.length) {
      console.error(
        `github graphql: HTTP ${res.status}`,
        body.errors?.map((e) => e.message).join("; ") ?? "",
      );
    }
    return body.data ?? null;
  } catch (err) {
    console.error("github graphql:", err);
    return null;
  }
}

const FIELDS_TTL_MS = 10 * 60_000;
let fieldsCache: { repo: string; at: number; byName: Map<string, IssueField> } | null = null;

async function resolveFields(env: Env): Promise<Map<string, IssueField> | null> {
  if (
    fieldsCache &&
    fieldsCache.repo === env.GITHUB_REPO &&
    Date.now() - fieldsCache.at < FIELDS_TTL_MS
  ) {
    return fieldsCache.byName;
  }
  const [owner, name] = env.GITHUB_REPO.split("/");
  const data = await ghGraphql(
    env,
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        issueFields(first: 50) {
          nodes {
            ... on IssueFieldSingleSelect { id name options { id name } }
            ... on IssueFieldNumber { id name }
            ... on IssueFieldDate { id name }
            ... on IssueFieldText { id name }
          }
        }
      }
    }`,
    { owner, name },
  );
  const nodes = data?.repository?.issueFields?.nodes as IssueField[] | undefined;
  if (!nodes) return null;
  const byName = new Map(nodes.filter((n) => n?.name).map((n) => [n.name, n]));
  fieldsCache = { repo: env.GITHUB_REPO, at: Date.now(), byName };
  return byName;
}

async function issueNodeId(env: Env, issueNumber: number): Promise<string | null> {
  const [owner, name] = env.GITHUB_REPO.split("/");
  const data = await ghGraphql(
    env,
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { id } }
    }`,
    { owner, name, number: issueNumber },
  );
  return data?.repository?.issue?.id ?? null;
}

/** Set the Incident fields on an issue. Best-effort: logs and skips what it can't resolve. */
export async function setIncidentFields(
  env: Env,
  issueNumber: number | null,
  values: IncidentFieldValues,
): Promise<void> {
  if (issueNumber == null || !env.GH_ISSUES_TOKEN) return;
  const fields = await resolveFields(env);
  if (!fields) return;

  const entries: Array<Record<string, unknown>> = [];

  const select = (fieldName: string, optionName: string | undefined) => {
    if (optionName === undefined) return;
    const field = fields.get(fieldName);
    const option = field?.options?.find((o) => o.name === optionName);
    if (!field || !option) {
      console.warn(`github incident field "${fieldName}" option "${optionName}" not found — skipped`);
      return;
    }
    entries.push({ fieldId: field.id, singleSelectOptionId: option.id });
  };
  const text = (fieldName: string, value: string | undefined) => {
    if (value === undefined) return;
    const field = fields.get(fieldName);
    if (!field) {
      console.warn(`github incident field "${fieldName}" not found — skipped`);
      return;
    }
    entries.push({ fieldId: field.id, textValue: value });
  };

  select(INCIDENT_FIELDS.severity, values.severity);
  select(INCIDENT_FIELDS.status, values.status);
  text(INCIDENT_FIELDS.component, values.component);
  text(INCIDENT_FIELDS.region, values.region);
  text(INCIDENT_FIELDS.detectedAt, values.detectedAt);
  if (values.downtimeMinutes !== undefined) {
    const field = fields.get(INCIDENT_FIELDS.downtime);
    if (field) entries.push({ fieldId: field.id, numberValue: values.downtimeMinutes });
    else console.warn(`github incident field "${INCIDENT_FIELDS.downtime}" not found — skipped`);
  }

  if (entries.length === 0) return;
  const issueId = await issueNodeId(env, issueNumber);
  if (!issueId) return;

  await ghGraphql(
    env,
    `mutation($input: SetIssueFieldValueInput!) {
      setIssueFieldValue(input: $input) { issue { number } }
    }`,
    { input: { issueId, issueFields: entries } },
  );
}
