/**
 * Bundled demo topology, activated with TOPOLOGY_URL=demo (see .dev.vars).
 * Asserts against REAL public endpoints so a local `wrangler dev --test-scheduled`
 * produces live data, plus two rigged components:
 *   - flaky-api: real 200s judged against a 25ms latency budget → DEGRADED
 *   - legacy:    .invalid hostname that never resolves → DOWN → incident
 */
export const DEMO_TOPOLOGY_YAML = `
defaults:
  timeout_ms: 5000
  degraded_latency_ms: 1000
  failures_to_degraded: 2
  failures_to_down: 3
  successes_to_up: 2

global:
  location_hint: weur
  components:
    - name: edge
      display_name: Edge Network
      assertions:
        - name: livez
          url: https://www.cloudflare.com/cdn-cgi/trace
        - name: readyz
          url: https://one.one.one.one/cdn-cgi/trace

regions:
  - slug: use1
    display_name: US East 1
    location_hint: enam
    components:
      - name: website
        display_name: Website
        assertions:
          - name: livez
            url: https://example.com/
          - name: healthz
            url: https://www.wikipedia.org/
            impact: degraded
      - name: search
        display_name: Search
        assertions:
          - name: livez
            url: https://www.google.com/generate_204
          - name: readyz
            url: https://duckduckgo.com/
      - name: flaky-api
        display_name: Flaky API (degraded demo)
        assertions:
          - name: healthz
            url: https://github.com/
            degraded_latency_ms: 25
            impact: degraded

  - slug: euw1
    display_name: EU West 1
    location_hint: weur
    components:
      - name: code-hosting
        display_name: Code Hosting
        assertions:
          - name: livez
            url: https://github.com/
      - name: registry
        display_name: Package Registry
        assertions:
          - name: livez
            url: https://registry.npmjs.org/-/ping
          - name: readyz
            url: https://registry.npmjs.org/-/ping
      - name: legacy
        display_name: Legacy Service (down demo)
        assertions:
          - name: livez
            url: https://legacy.demo-down.invalid/livez
          - name: readyz
            url: https://legacy.demo-down.invalid/readyz
`;
