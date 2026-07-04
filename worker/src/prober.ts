import type { ProbeSpec } from "./types";

export interface ProbeResult {
  ok: boolean;
  slow: boolean;
  httpStatus: number | null;
  latencyMs: number;
  error: string | null;
}

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
    const ok = res.status >= 200 && res.status < 300;
    // Drain the body so the connection is reusable.
    await res.body?.cancel();
    return {
      ok,
      slow: ok && latencyMs > spec.degraded_latency_ms,
      httpStatus: res.status,
      latencyMs,
      error: ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      slow: false,
      httpStatus: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? (err.name === "TimeoutError" ? "timeout" : err.message) : String(err),
    };
  }
}
