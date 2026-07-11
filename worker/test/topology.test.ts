import { describe, expect, it } from "vitest";
import { fetchTopology, parseTopology } from "../src/topology";

const VALID_YAML = `
defaults:
  timeout_ms: 4000
global:
  location_hint: weur
  components:
    - name: tenants
      probes:
        livez: { url: "http://t:81/livez" }
        readyz: { url: "http://t:81/readyz", timeout_ms: 1000 }
regions:
  - slug: use1
    components:
      - name: ddns
        probes:
          healthz: { url: "http://d:81/healthz" }
`;

describe("parseTopology", () => {
  it("normalizes global into a pseudo-region and applies defaults", () => {
    const t = parseTopology(VALID_YAML);
    expect(t.regions.map((r) => r.slug)).toEqual(["global", "use1"]);
    const tenants = t.regions[0]!.components[0]!;
    expect(tenants.probes.livez?.timeout_ms).toBe(4000);
    expect(tenants.probes.readyz?.timeout_ms).toBe(1000);
    expect(tenants.probes.healthz).toBeUndefined();
    expect(tenants.probes.livez?.failures_to_down).toBe(3);
  });

  it("rejects unknown probe names (closed vocabulary)", () => {
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    components:
      - name: x
        probes:
          public: { url: "https://x" }
`),
    ).toThrow();
  });

  it("rejects invalid Durable Object location hints", () => {
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    location_hint: europe
    components:
      - name: x
        probes:
          livez: { url: "https://x" }
`),
    ).toThrow();
  });

  it("rejects components with zero probes", () => {
    expect(() =>
      parseTopology(`
regions:
  - slug: use1
    components:
      - name: x
        probes: {}
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
