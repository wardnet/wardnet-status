import type { ProbeSpec } from "./types";

export interface ProbeResult {
  ok: boolean;
  slow: boolean;
  httpStatus: number | null;
  latencyMs: number;
  error: string | null;
  /** Response body (truncated) — captured only for failing or slow responses. */
  bodySnippet: string | null;
}

/** Incident reports quote the body; cap it so a huge error page stays readable. */
const BODY_SNIPPET_MAX = 600;

/**
 * Statuses that fail regardless of `expect_status`. Through a gateway/ingress these mean
 * "upstream unreachable" — never let a loose `expect_status` whitelist them.
 */
const ALWAYS_FAIL = new Set([502, 503, 504]);

/** Execute one probe: 2xx within timeout = ok; ok beyond the latency budget = slow. */
export async function executeProbe(
  spec: ProbeSpec,
  fetcher: typeof fetch = fetch,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetcher(spec.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(spec.timeout_ms),
      headers: { "user-agent": "wardnet-status-prober/1" },
    });
    const latencyMs = Date.now() - started;
    const ok =
      spec.expect_status != null
        ? res.status === spec.expect_status && !ALWAYS_FAIL.has(res.status)
        : res.status >= 200 && res.status < 300;
    const slow = ok && latencyMs > spec.degraded_latency_ms;

    let bodySnippet: string | null = null;
    if (!ok || slow) {
      // Failing/slow responses feed incident reports — keep (a slice of) the body.
      try {
        const text = await res.text();
        bodySnippet = text.length > BODY_SNIPPET_MAX ? `${text.slice(0, BODY_SNIPPET_MAX)}…` : text;
      } catch {
        bodySnippet = null;
      }
    } else {
      // Drain the body so the connection is reusable.
      await res.body?.cancel();
    }

    return {
      ok,
      slow,
      httpStatus: res.status,
      latencyMs,
      error: ok
        ? null
        : `HTTP ${res.status}${spec.expect_status != null ? ` (expected ${spec.expect_status})` : ""}`,
      bodySnippet,
    };
  } catch (err) {
    return {
      ok: false,
      slow: false,
      httpStatus: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? (err.name === "TimeoutError" ? "timeout" : err.message) : String(err),
      bodySnippet: null,
    };
  }
}
