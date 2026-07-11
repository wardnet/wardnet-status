import { describe, expect, it } from "vitest";
import { executeProbe } from "../src/prober";
import type { ProbeSpec } from "../src/types";

const spec = (over: Partial<ProbeSpec> = {}): ProbeSpec => ({
  url: "https://example.test/probe",
  timeout_ms: 5000,
  degraded_latency_ms: 1000,
  failures_to_degraded: 2,
  failures_to_down: 3,
  successes_to_up: 2,
  ...over,
});

const fetcherReturning = (status: number, body = ""): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("executeProbe", () => {
  describe("default (no expect_status) — any 2xx is ok", () => {
    it("200 → ok", async () => {
      const r = await executeProbe(spec(), fetcherReturning(200));
      expect(r.ok).toBe(true);
      expect(r.httpStatus).toBe(200);
      expect(r.error).toBeNull();
    });

    it("401 → not ok (no assertion means only 2xx passes)", async () => {
      const r = await executeProbe(spec(), fetcherReturning(401));
      expect(r.ok).toBe(false);
      expect(r.error).toBe("HTTP 401");
    });

    it("500 → not ok", async () => {
      const r = await executeProbe(spec(), fetcherReturning(500));
      expect(r.ok).toBe(false);
    });
  });

  describe("expect_status: 401 — API-gateway edge check", () => {
    it("401 → ok (service answered through the GW)", async () => {
      const r = await executeProbe(spec({ expect_status: 401 }), fetcherReturning(401));
      expect(r.ok).toBe(true);
      expect(r.error).toBeNull();
    });

    it("200 → not ok, and the error names the expectation", async () => {
      const r = await executeProbe(spec({ expect_status: 401 }), fetcherReturning(200));
      expect(r.ok).toBe(false);
      expect(r.error).toBe("HTTP 200 (expected 401)");
    });

    it("502 → not ok (GW can't reach upstream), even though 502 != 401 anyway", async () => {
      const r = await executeProbe(spec({ expect_status: 401 }), fetcherReturning(502));
      expect(r.ok).toBe(false);
      expect(r.error).toBe("HTTP 502 (expected 401)");
    });
  });

  describe("always-fail guardrail beats a loose expect_status", () => {
    for (const status of [502, 503, 504]) {
      it(`expect_status ${status} still fails (upstream-unreachable is never healthy)`, async () => {
        const r = await executeProbe(spec({ expect_status: status }), fetcherReturning(status));
        expect(r.ok).toBe(false);
      });
    }
  });

  it("timeout → not ok", async () => {
    const boom: typeof fetch = (async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    const r = await executeProbe(spec({ expect_status: 401 }), boom);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timeout");
  });
});
