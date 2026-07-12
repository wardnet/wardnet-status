import { parse } from "yaml";
import { z } from "zod";
import type { ProbeName, RegionSpec, Topology } from "./types";

export const PROBE_NAMES: ProbeName[] = ["livez", "readyz", "healthz"];

const defaultsSchema = z.object({
  timeout_ms: z.number().int().positive().default(5000),
  degraded_latency_ms: z.number().int().positive().default(1000),
  failures_to_degraded: z.number().int().positive().default(2),
  failures_to_down: z.number().int().positive().default(3),
  successes_to_up: z.number().int().positive().default(2),
});

const probeSchema = z.object({
  url: z.string().url(),
  timeout_ms: z.number().int().positive().optional(),
  degraded_latency_ms: z.number().int().positive().optional(),
  // Expected HTTP status for "ok" (default: any 2xx). Set e.g. 401 for an API-gateway
  // edge probe where the service answers 401 through the GW. 502/503/504 always fail.
  expect_status: z.number().int().min(100).max(599).optional(),
  // "spa" runs the SPA-readiness executor (shell → assets, content-type checked)
  // instead of a single request. Default "http".
  check: z.enum(["http", "spa"]).optional(),
});

const componentSchema = z.object({
  name: z.string().min(1),
  display_name: z.string().min(1).optional(),
  // The probe vocabulary is closed: exactly these three names, each optional.
  probes: z
    .object({
      livez: probeSchema.optional(),
      readyz: probeSchema.optional(),
      healthz: probeSchema.optional(),
    })
    .strict()
    .refine((p) => PROBE_NAMES.some((n) => p[n] !== undefined), {
      message: "component must expose at least one probe",
    }),
});

// Cloudflare Durable Object location hints — anything else would make the
// DO namespace.get() reject at fan-out time, silently killing the region.
const locationHintSchema = z.enum([
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
]);

const regionSchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1).optional(),
  location_hint: locationHintSchema.optional(),
  components: z.array(componentSchema).min(1),
});

const topologyFileSchema = z.object({
  defaults: defaultsSchema.default({}),
  global: z
    .object({
      location_hint: locationHintSchema.optional(),
      components: z.array(componentSchema).min(1),
    })
    .optional(),
  regions: z.array(regionSchema).default([]),
});

/** Parse + validate the raw YAML into the normalized Topology (defaults applied). */
export function parseTopology(yamlText: string): Topology {
  const file = topologyFileSchema.parse(parse(yamlText));
  const d = file.defaults;

  const normalizeComponents = (
    components: z.infer<typeof componentSchema>[],
  ) =>
    components.map((c) => ({
      name: c.name,
      display_name: c.display_name ?? c.name,
      probes: Object.fromEntries(
        PROBE_NAMES.flatMap((name) => {
          const p = c.probes[name];
          if (!p) return [];
          return [
            [
              name,
              {
                url: p.url,
                timeout_ms: p.timeout_ms ?? d.timeout_ms,
                degraded_latency_ms:
                  p.degraded_latency_ms ?? d.degraded_latency_ms,
                failures_to_degraded: d.failures_to_degraded,
                failures_to_down: d.failures_to_down,
                successes_to_up: d.successes_to_up,
                expect_status: p.expect_status,
                check: p.check,
              },
            ],
          ];
        }),
      ),
    }));

  const regions: RegionSpec[] = [];
  if (file.global) {
    regions.push({
      slug: "global",
      display_name: "Global",
      location_hint: file.global.location_hint,
      components: normalizeComponents(file.global.components),
    });
  }
  for (const r of file.regions) {
    regions.push({
      slug: r.slug,
      display_name: r.display_name ?? r.slug,
      location_hint: r.location_hint,
      components: normalizeComponents(r.components),
    });
  }
  return { regions };
}

export interface TopologyFetchResult {
  topology: Topology;
  /** True when serving last-known-good because the fetch or validation failed. */
  stale: boolean;
  etag: string | null;
}

interface CachedTopology {
  yamlText: string;
  etag: string | null;
}

/**
 * Fetch topology.yaml from GitHub raw with ETag caching, falling back to the
 * last-known-good copy on any failure. `storage` is durable (DO storage or a
 * KV-like map in tests).
 */
export async function fetchTopology(
  url: string,
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  },
  fetcher: typeof fetch = fetch,
): Promise<TopologyFetchResult> {
  const cached = (await storage.get("topology:last-good")) as
    | CachedTopology
    | undefined;

  try {
    const headers: Record<string, string> = {};
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const res = await fetcher(url, { headers });

    if (res.status === 304 && cached) {
      return { topology: parseTopology(cached.yamlText), stale: false, etag: cached.etag };
    }
    if (!res.ok) throw new Error(`topology fetch: HTTP ${res.status}`);

    const yamlText = await res.text();
    const topology = parseTopology(yamlText); // throws on invalid → falls back
    const etag = res.headers.get("etag");
    await storage.put("topology:last-good", { yamlText, etag } satisfies CachedTopology);
    return { topology, stale: false, etag };
  } catch (err) {
    if (cached) {
      return { topology: parseTopology(cached.yamlText), stale: true, etag: cached.etag };
    }
    throw err;
  }
}
