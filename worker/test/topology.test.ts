import { describe, expect, it } from "vitest";
import { fetchTopology, parseTopology } from "../src/topology";

const VALID_YAML = `
defaults:
  timeout_ms: 4000
global:
  location_hint: weur
  components:
    - name: tenants
      assertions:
        - { name: livez, url: "http://t:81/livez" }
        - { name: readyz, url: "http://t:81/readyz", timeout_ms: 1000, failures_to_degraded: 1 }
        - { name: gateway, url: "https://api.example/v1/me", expect_status: 401 }
regions:
  - slug: use1
    components:
      - name: ddns
        assertions:
          - { name: healthz, url: "http://d:81/healthz", impact: degraded }
`;

describe("parseTopology", () => {
  it("normalizes global into a pseudo-region and applies defaults", () => {
    const t = parseTopology(VALID_YAML);
    expect(t.regions.map((r) => r.slug)).toEqual(["global", "use1"]);
    const tenants = t.regions[0]!.components[0]!;
    const byName = Object.fromEntries(tenants.assertions.map((a) => [a.name, a]));
    expect(byName.livez?.timeout_ms).toBe(4000);
    expect(byName.readyz?.timeout_ms).toBe(1000);
    expect(byName.livez?.failures_to_down).toBe(3);
    // Per-assertion ladder override beats the defaults.
    expect(byName.readyz?.failures_to_degraded).toBe(1);
    expect(byName.livez?.failures_to_degraded).toBe(2);
    // Impact defaults to "down"; declared "degraded" is preserved.
    expect(byName.gateway?.impact).toBe("down");
    expect(byName.gateway?.expect_status).toBe(401);
    const ddns = t.regions[1]!.components[0]!;
    expect(ddns.assertions[0]?.impact).toBe("degraded");
  });

  it("rejects duplicate assertion names within a component", () => {
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    components:
      - name: x
        assertions:
          - { name: readyz, url: "https://x/a" }
          - { name: readyz, url: "https://x/b" }
`),
    ).toThrow();
  });

  it("rejects invalid impact values", () => {
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    components:
      - name: x
        assertions:
          - { name: readyz, url: "https://x", impact: fatal }
`),
    ).toThrow();
  });

  it("rejects unknown keys (a typo'd impact must fail parse, not default to down)", () => {
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    components:
      - name: x
        assertions:
          - { name: healthz, url: "https://x", imapct: degraded }
`),
    ).toThrow();
  });

  it("rejects inverted ladder thresholds after merging with defaults", () => {
    // Only failures_to_degraded is overridden; merged with the default
    // failures_to_down (3) the pair is inverted and would skip DEGRADED.
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    components:
      - name: x
        assertions:
          - { name: readyz, url: "https://x", failures_to_degraded: 5 }
`),
    ).toThrow(/failures_to_degraded/);
    // A consistent override of both is fine.
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    components:
      - name: x
        assertions:
          - { name: readyz, url: "https://x", failures_to_degraded: 5, failures_to_down: 7 }
`),
    ).not.toThrow();
  });

  it("rejects invalid Durable Object location hints", () => {
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    location_hint: europe
    components:
      - name: x
        assertions:
          - { name: livez, url: "https://x" }
`),
    ).toThrow();
  });

  it("rejects components with zero assertions", () => {
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    components:
      - name: x
        assertions: []
`),
    ).toThrow();
  });
});

function memStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async (k: string) => map.get(k),
    put: async (k: string, v: unknown) => void map.set(k, v),
  };
}

describe("fetchTopology", () => {
  it("caches last-known-good and serves it stale on fetch failure", async () => {
    const storage = memStorage();
    const okFetch = (async () =>
      new Response(VALID_YAML, { headers: { etag: '"abc"' } })) as typeof fetch;
    const first = await fetchTopology("https://x/topology.yaml", storage, okFetch);
    expect(first.stale).toBe(false);

    const failFetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const second = await fetchTopology("https://x/topology.yaml", storage, failFetch);
    expect(second.stale).toBe(true);
    expect(second.topology.regions.length).toBe(2);
  });

  it("serves last-known-good when the new file is invalid", async () => {
    const storage = memStorage();
    await fetchTopology(
      "https://x/topology.yaml",
      storage,
      (async () => new Response(VALID_YAML)) as typeof fetch,
    );
    const res = await fetchTopology(
      "https://x/topology.yaml",
      storage,
      (async () => new Response("regions: [{}]")) as typeof fetch,
    );
    expect(res.stale).toBe(true);
  });

  it("uses ETag and honours 304", async () => {
    const storage = memStorage();
    let sawIfNoneMatch: string | null = null;
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      sawIfNoneMatch = h.get("If-None-Match");
      if (sawIfNoneMatch === '"abc"') return new Response(null, { status: 304 });
      return new Response(VALID_YAML, { headers: { etag: '"abc"' } });
    }) as typeof fetch;

    await fetchTopology("https://x/topology.yaml", storage, fetcher);
    const second = await fetchTopology("https://x/topology.yaml", storage, fetcher);
    expect(sawIfNoneMatch).toBe('"abc"');
    expect(second.stale).toBe(false);
    expect(second.topology.regions.length).toBe(2);
  });

  it("throws when there is no cache and the fetch fails", async () => {
    await expect(
      fetchTopology(
        "https://x/topology.yaml",
        memStorage(),
        (async () => new Response("x", { status: 500 })) as typeof fetch,
      ),
    ).rejects.toThrow();
  });
});
