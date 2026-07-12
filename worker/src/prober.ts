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

export type AssetKind = "module" | "script" | "style";
export interface AssetRef {
  url: string;
  kind: AssetKind;
}

/**
 * WHATWG "JavaScript MIME type" essence. A `type="module"` script is REFUSED by
 * browsers (per the HTML spec's strict MIME check) unless served as one of these —
 * `text/plain`, `text/html`, etc. all fail, and the app silently white-screens.
 */
const JS_MIME_RE = /^(application|text)\/(x-)?(java|ecma)script\b/i;

/**
 * Extract the scripts and stylesheets an SPA shell references, tagged by kind and
 * resolved to absolute http(s) URLs against `baseUrl`. Regex rather than a DOM
 * parser so it runs in both workerd and the node test env; scoped to `<script src>`
 * and `<link rel="stylesheet" href>` — the load-bearing assets (favicons don't matter).
 * `kind` matters: a module script has a stricter MIME requirement than a classic one.
 */
export function extractAssetRefs(html: string, baseUrl: string): AssetRef[] {
  const raw: { ref: string; kind: AssetKind }[] = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!src?.[1]) continue;
    const kind: AssetKind = /\btype\s*=\s*["']?module\b/i.test(tag) ? "module" : "script";
    raw.push({ ref: src[1], kind });
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?\s*stylesheet/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href?.[1]) raw.push({ ref: href[1], kind: "style" });
  }

  const base = new URL(baseUrl);
  const seen = new Set<string>();
  const out: AssetRef[] = [];
  for (const { ref, kind } of raw) {
    let abs: URL;
    try {
      abs = new URL(ref, base);
    } catch {
      continue; // malformed ref — skip
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    const url = abs.toString();
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ url, kind });
    }
  }
  return out;
}

/**
 * SPA readiness: fetch the shell, then fetch every asset it references and check
 * its content-type. An SPA ingress serves index.html (200, text/html) for ANY
 * missing path, so a plain 200 can't distinguish "asset served" from "fell back to
 * the shell". Fail an asset when it: is non-2xx / unreachable; comes back as
 * text/html (missing file → the fallback); or is a `type="module"` script NOT served
 * as a JavaScript MIME type — browsers refuse to execute those (strict module MIME
 * check), so the app white-screens even though every request returned 200.
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
    const assets = extractAssetRefs(html, spec.url);
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

    // 3. Each asset must be a real, executable file — right MIME, not the fallback.
    const results = await Promise.all(
      assets.map(async ({ url, kind }) => {
        try {
          const res = await fetcher(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(spec.timeout_ms),
            headers: PROBE_HEADERS,
          });
          const ct = (res.headers.get("content-type") ?? "").toLowerCase();
          await res.body?.cancel();
          let why: string | null = null;
          if (!(res.status >= 200 && res.status < 300)) {
            why = `HTTP ${res.status}`;
          } else if (ct.startsWith("text/html")) {
            why = "served text/html (missing asset — deploy broken?)";
          } else if (kind === "module" && !JS_MIME_RE.test(ct)) {
            // The exact browser-refusal case: a module served as text/plain etc.
            why = `module served as "${ct || "no content-type"}" — browsers refuse to execute (needs a JavaScript MIME type)`;
          }
          return { url, ok: why === null, status: res.status as number | null, why };
        } catch {
          return { url, ok: false, status: null as number | null, why: "unreachable" };
        }
      }),
    );

    const bad = results.find((r) => !r.ok);
    const latencyMs = elapsed();
    if (bad) {
      return {
        ok: false,
        slow: false,
        httpStatus: bad.status,
        latencyMs,
        error: `asset ${bad.url}: ${bad.why}`,
        bodySnippet: null,
      };
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
