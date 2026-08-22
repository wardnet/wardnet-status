// biome-ignore-all lint/correctness/noNodejsModules: this test reads the real
// topology.yaml off disk and runs only under vitest on Node — it is never
// bundled into the Worker, where the rule's concern actually applies.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTopology } from "../src/topology";

/**
 * Validates the REAL topology.yaml at the repo root — the artifact every
 * prober fetches from main at runtime. It runs in ci-test on every pull
 * request and every push to main, so an invalid file can never land on main
 * and silently pin the probers to last-known-good. deploy.yml skips topology
 * changes (they need no deploy), which is why that gate has to live here.
 */
describe("topology.yaml (repo root)", () => {
  it("parses against the schema", () => {
    const yamlText = readFileSync(fileURLToPath(new URL("../../topology.yaml", import.meta.url).href), "utf8");
    const topology = parseTopology(yamlText);
    expect(topology.regions.length).toBeGreaterThan(0);
    for (const region of topology.regions) {
      expect(region.components.length).toBeGreaterThan(0);
      for (const component of region.components) {
        expect(component.assertions.length).toBeGreaterThan(0);
      }
    }
  });
});
