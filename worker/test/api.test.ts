import { describe, expect, it } from "vitest";
import { aggregateHourlyToDaily, intParam } from "../src/api";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const hourly = (
  hour_ts: number,
  over: Partial<{ samples: number; up: number; degraded: number; down: number; latency_max: number }> = {},
) => ({
  hour_ts,
  region: "global",
  component: "tenants",
  probe: "readyz",
  samples: 60,
  up: 60,
  degraded: 0,
  down: 0,
  latency_sum: 100,
  latency_max: 40,
  ...over,
});

describe("intParam (untrusted query params)", () => {
  it("uses the fallback for garbage", () => {
    expect(intParam("abc", 48, 336)).toBe(48);
    expect(intParam("NaN", 48, 336)).toBe(48);
    expect(intParam("Infinity", 48, 336)).toBe(48);
  });

  it("clamps into [1, max]", () => {
    expect(intParam("0", 48, 336)).toBe(1);
    expect(intParam("-5", 48, 336)).toBe(1);
    expect(intParam("9999", 48, 336)).toBe(336);
    expect(intParam("24.9", 48, 336)).toBe(24);
  });

  it("missing param → fallback", () => {
    expect(intParam(null, 90, 365)).toBe(90);
  });
});

describe("aggregateHourlyToDaily (recent-day uptime, unmaterialized)", () => {
  // 2026-07-11 00:00 UTC — the day that had outages while its daily rollup
  // didn't exist yet (nightly job runs 03:17 UTC). Regression: that downtime
  // was invisible because only *today* was synthesized from hourly.
  const yesterday = 20645 * DAY;
  const today = yesterday + DAY;

  it("buckets multi-day hourly per UTC day and preserves yesterday's downtime", () => {
    const out = aggregateHourlyToDaily([
      hourly(yesterday + 13 * HOUR, { up: 56, down: 4, latency_max: 70 }), // outage hour
      hourly(yesterday + 14 * HOUR),
      hourly(today + 1 * HOUR),
    ]);

    const y = out.find((r) => r.day_ts === yesterday);
    const t = out.find((r) => r.day_ts === today);
    expect(y).toBeDefined();
    expect(y!.samples).toBe(120);
    expect(y!.down).toBe(4); // the bug: this was dropped, so the bar read 100%
    expect(y!.latency_max).toBe(70); // max, not sum
    expect(t!.down).toBe(0);
    expect(t!.samples).toBe(60);
  });

  it("keeps distinct probes/components separate within a day", () => {
    const out = aggregateHourlyToDaily([
      hourly(yesterday + 1 * HOUR, { probe: "livez" } as never),
      hourly(yesterday + 1 * HOUR, { probe: "readyz" } as never),
    ]);
    expect(out).toHaveLength(2);
  });

  it("empty input → empty output", () => {
    expect(aggregateHourlyToDaily([])).toEqual([]);
  });
});
