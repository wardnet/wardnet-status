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
  // SPA readiness is a compound check (shell → assets), not a single request.
  if (spec.check === "spa") return executeSpaProbe(spec, fetcher);

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

const PROBE_HEADERS = { "user-agent": "wardnet-status-prober/1" };

/**
 * Extract the JS-module and stylesheet URLs an SPA shell references, resolved to
 * absolute http(s) URLs against `baseUrl`. Regex rather than a DOM parser so it
 * runs in both workerd and the node test env; scoped to `<script src>` and
 * `<link rel="stylesheet" href>` — the load-bearing assets (favicons don't matter).
 */
export function extractAssetUrls(html: string, baseUrl: string): string[] {
  const refs: string[] = [];
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (let m; (m = scriptRe.exec(html)); ) if (m[1]) refs.push(m[1]);
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?\s*stylesheet/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href?.[1]) refs.push(href[1]);
  }

  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    let abs: URL;
    try {
      abs = new URL(ref, base);
    } catch {
      continue; // malformed ref — skip
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    const s = abs.toString();
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * SPA readiness: fetch the shell, then fetch every asset it references and assert
 * none come back as `text/html`. An SPA ingress serves index.html (200, text/html)
 * for ANY missing path, so a plain 200 can't distinguish "asset served" from "fell
 * back to the shell" — content-type is the only tell. Any asset that returns
 * text/html (missing file), a non-2xx, or is unreachable = broken deploy → fail.
 */
export async function executeSpaProbe(
  spec: ProbeSpec,
  fetcher: typeof fetch = fetch,
): Promise<ProbeResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  try {
    // 1. Shell must be a real HTML document.
    const shell = await fetcher(spec.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(spec.timeout_ms),
      headers: PROBE_HEADERS,
    });
    const shellCt = shell.headers.get("content-type") ?? "";
    if (!(shell.status >= 200 && shell.status < 300 && shellCt.includes("text/html"))) {
      return {
        ok: false,
        slow: false,
        httpStatus: shell.status,
        latencyMs: elapsed(),
        error: `shell HTTP ${shell.status}${shellCt ? ` (${shellCt})` : ""}`,
        bodySnippet: await snippet(shell),
      };
    }
    const html = await shell.text();

    // 2. The shell must reference assets — "none found" is a broken build, not a pass.
    const assets = extractAssetUrls(html, spec.url);
    if (assets.length === 0) {
      return {
        ok: false,
        slow: false,
        httpStatus: shell.status,
        latencyMs: elapsed(),
        error: "shell served but references no assets (broken build?)",
        bodySnippet: html.length > BODY_SNIPPET_MAX ? `${html.slice(0, BODY_SNIPPET_MAX)}…` : html,
      };
    }

    // 3. Every referenced asset must be a real file (not the text/html fallback).
    const results = await Promise.all(
      assets.map(async (url) => {
        try {
          const res = await fetcher(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(spec.timeout_ms),
            headers: PROBE_HEADERS,
          });
          const ct = res.headers.get("content-type") ?? "";
          await res.body?.cancel();
          return {
            url,
            ok: res.status >= 200 && res.status < 300 && !ct.startsWith("text/html"),
            status: res.status as number | null,
            ct,
          };
        } catch {
          return { url, ok: false, status: null as number | null, ct: "" };
        }
      }),
    );

    const bad = results.find((r) => !r.ok);
    const latencyMs = elapsed();
    if (bad) {
      const why =
        bad.status === null
          ? "unreachable"
          : bad.ct.startsWith("text/html")
            ? "served text/html (missing asset — deploy broken?)"
            : `HTTP ${bad.status}`;
      return { ok: false, slow: false, httpStatus: bad.status, latencyMs, error: `asset ${bad.url}: ${why}`, bodySnippet: null };
    }

    return {
      ok: true,
      slow: latencyMs > spec.degraded_latency_ms,
      httpStatus: shell.status,
      latencyMs,
      error: null,
      bodySnippet: null,
    };
  } catch (err) {
    return {
      ok: false,
      slow: false,
      httpStatus: null,
      latencyMs: elapsed(),
      error: err instanceof Error ? (err.name === "TimeoutError" ? "timeout" : err.message) : String(err),
      bodySnippet: null,
    };
  }
}

/** Read a (truncated) body snippet, tolerating a body that can't be read. */
async function snippet(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.length > BODY_SNIPPET_MAX ? `${text.slice(0, BODY_SNIPPET_MAX)}…` : text;
  } catch {
    return null;
  }
}
