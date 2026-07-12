import { describe, expect, it } from "vitest";
import { executeProbe, executeSpaProbe, extractAssetRefs } from "../src/prober";
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

describe("extractAssetRefs", () => {
  it("tags scripts vs stylesheets, resolves absolute, ignores favicons", () => {
    const html = `
      <link rel="icon" href="/favicon.png">
      <link rel="stylesheet" href="/assets/x.css">
      <script type="module" crossorigin src="/assets/x.js"></script>`;
    expect(extractAssetRefs(html, "https://acc.test/")).toEqual([
      { url: "https://acc.test/assets/x.js", kind: "module" },
      { url: "https://acc.test/assets/x.css", kind: "style" },
    ]);
  });

  it("distinguishes module from classic scripts", () => {
    const html = `<script type="module" src="/m.js"></script><script src="/c.js"></script>`;
    expect(extractAssetRefs(html, "https://acc.test/")).toEqual([
      { url: "https://acc.test/m.js", kind: "module" },
      { url: "https://acc.test/c.js", kind: "script" },
    ]);
  });

  it("dedupes and skips malformed / non-http refs", () => {
    const html = `<script src="/a.js"></script><script src="/a.js"></script><script src="data:,x"></script>`;
    expect(extractAssetRefs(html, "https://acc.test/")).toEqual([
      { url: "https://acc.test/a.js", kind: "script" },
    ]);
  });

  it("no assets → empty", () => {
    expect(extractAssetRefs("<html><body>hi</body></html>", "https://acc.test/")).toEqual([]);
  });
});

describe("executeSpaProbe", () => {
  const BASE = "https://account.wardnet.network/";
  const JS = "https://account.wardnet.network/assets/index-abc.js";
  const CSS = "https://account.wardnet.network/assets/index-def.css";
  // Vite emits a type="module" entry script — subject to the strict browser MIME check.
  const SHELL = `<!doctype html><html><head><title>My Account</title>
    <link rel="stylesheet" href="/assets/index-def.css">
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    </head><body><div id="root"></div></body></html>`;

  // A fetcher backed by a URL→response map; unknown URLs throw (test would be wrong).
  const routed = (
    routes: Record<string, { status?: number; ct?: string; body?: string }>,
  ): typeof fetch =>
    (async (input: string) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const r = routes[url];
      if (!r) throw new Error(`unexpected fetch: ${url}`);
      return new Response(r.body ?? "", {
        status: r.status ?? 200,
        headers: r.ct ? { "content-type": r.ct } : {},
      });
    }) as unknown as typeof fetch;

  const spaSpec = spec({ url: BASE, check: "spa" });

  it("healthy: module served as JS MIME, css lenient → ok", async () => {
    const r = await executeSpaProbe(
      spaSpec,
      routed({
        [BASE]: { ct: "text/html", body: SHELL },
        [JS]: { ct: "application/javascript" },
        [CSS]: { ct: "text/plain" }, // stylesheets aren't strictly MIME-checked by browsers
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
  });

  it("module script served as text/plain → not ok (browsers refuse to execute it)", async () => {
    // The real account-app bug: 200 everywhere, but the module is text/plain → white screen.
    const r = await executeSpaProbe(
      spaSpec,
      routed({
        [BASE]: { ct: "text/html", body: SHELL },
        [JS]: { ct: "text/plain" },
        [CSS]: { ct: "text/css" },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain(JS);
    expect(r.error).toContain("text/plain");
    expect(r.error).toContain("refuse to execute");
  });

  it("broken deploy: a missing asset falls back to text/html → not ok, names the asset", async () => {
    const r = await executeSpaProbe(
      spaSpec,
      routed({
        [BASE]: { ct: "text/html", body: SHELL },
        [JS]: { ct: "text/html", body: SHELL }, // missing → nginx served index.html
        [CSS]: { ct: "text/css" },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain(JS);
    expect(r.error).toContain("text/html");
  });

  it("classic (non-module) script as text/plain → ok (browsers tolerate it)", async () => {
    const CLASSIC = "https://account.wardnet.network/legacy.js";
    const r = await executeSpaProbe(
      spec({ url: BASE, check: "spa" }),
      routed({
        [BASE]: { ct: "text/html", body: `<html><head><script src="/legacy.js"></script></head></html>` },
        [CLASSIC]: { ct: "text/plain" },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("shell not HTML (e.g. gateway error) → not ok", async () => {
    const r = await executeSpaProbe(spaSpec, routed({ [BASE]: { status: 502, ct: "text/html", body: "bad gateway" } }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("shell HTTP 502");
  });

  it("shell with no asset refs → not ok (broken build, never a silent pass)", async () => {
    const r = await executeSpaProbe(spaSpec, routed({ [BASE]: { ct: "text/html", body: "<html><body>oops</body></html>" } }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no assets");
  });

  it("executeProbe dispatches check:'spa' to the SPA executor", async () => {
    const r = await executeProbe(
      spaSpec,
      routed({ [BASE]: { ct: "text/html", body: SHELL }, [JS]: { ct: "application/javascript" }, [CSS]: { ct: "text/css" } }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("probes bypass cache (a monitor must hit origin, never a cached copy)", () => {
  // `cache` isn't on the Workers RequestInit type (runtime supports it, types lag),
  // so capture the init loosely to read it back.
  it("executeProbe requests with cache: no-store", async () => {
    const inits: Record<string, unknown>[] = [];
    const f: typeof fetch = (async (_u: string, init: Record<string, unknown>) => {
      inits.push(init);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await executeProbe(spec(), f);
    expect(inits[0]?.cache).toBe("no-store");
  });

  it("executeSpaProbe requests shell and assets with cache: no-store", async () => {
    const BASE = "https://acc.test/";
    const JS = "https://acc.test/a.js";
    const SHELL = `<html><head><script type="module" src="/a.js"></script></head></html>`;
    const seen: Record<string, Record<string, unknown>> = {};
    const f: typeof fetch = (async (u: string, init: Record<string, unknown>) => {
      seen[u] = init;
      return u === BASE
        ? new Response(SHELL, { status: 200, headers: { "content-type": "text/html" } })
        : new Response("", { status: 200, headers: { "content-type": "application/javascript" } });
    }) as unknown as typeof fetch;
    await executeSpaProbe(spec({ url: BASE, check: "spa" }), f);
    expect(seen[BASE]?.cache).toBe("no-store");
    expect(seen[JS]?.cache).toBe("no-store");
  });
});
