import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTopology } from "../src/topology";

/**
 * Validates the REAL topology.yaml at the repo root — the artifact every
 * prober fetches from main at runtime. CI runs this on topology-only pushes
 * (.github/workflows/validate-topology.yml) so an invalid file can never land
 * on main and silently pin the probers to last-known-good.
 */
describe("topology.yaml (repo root)", () => {
  it("parses against the schema", () => {
    const yamlText = readFileSync(join(__dirname, "../../topology.yaml"), "utf8");
    const topology = parseTopology(yamlText);
    expect(topology.regions.length).toBeGreaterThan(0);
    for (const region of topology.regions) {
      expect(region.components.length).toBeGreaterThan(0);
      for (const component of region.components) {
        expect(Object.keys(component.probes).length).toBeGreaterThan(0);
      }
    }
  });
});
