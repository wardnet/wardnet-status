import { render } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { hourlyAverages, LatencyChart } from "../components/LatencyChart";
import type { HourlyRow } from "../api/types";

const HOUR = 3_600_000;

function row(partial: Partial<HourlyRow>): HourlyRow {
  return {
    hour_ts: 0,
    region: "use1",
    component: "ddns",
    probe: "readyz",
    samples: 60,
    up: 60,
    degraded: 0,
    down: 0,
    latency_sum: 60 * 50,
    latency_max: 80,
    ...partial,
  };
}

describe("hourlyAverages", () => {
  it("collapses per-assertion rows into one point per hour", () => {
    // rollup_hourly keys rows by (hour, region, component, probe) — a component
    // with three assertions yields three rows per hour. The chart must merge
    // them or it draws several points on the same x.
    const rows = [
      row({ probe: "livez", latency_sum: 60 * 10 }),
      row({ probe: "readyz", latency_sum: 60 * 50 }),
      row({ probe: "healthz", latency_sum: 60 * 300 }),
      row({ hour_ts: HOUR, probe: "livez", latency_sum: 60 * 12 }),
      row({ hour_ts: HOUR, probe: "readyz", latency_sum: 60 * 48 }),
    ];
    const points = hourlyAverages(rows);
    expect(points).toEqual([
      { ts: 0, avg: 120 },
      { ts: HOUR, avg: 30 },
    ]);
  });

  it("weights the average by sample count, not per assertion", () => {
    const points = hourlyAverages([
      row({ probe: "livez", samples: 10, latency_sum: 10 * 100 }),
      row({ probe: "readyz", samples: 30, latency_sum: 30 * 20 }),
    ]);
    expect(points).toEqual([{ ts: 0, avg: (10 * 100 + 30 * 20) / 40 }]);
  });

  it("orders points by hour and drops empty rows", () => {
    const points = hourlyAverages([
      row({ hour_ts: 2 * HOUR, latency_sum: 60 * 30 }),
      row({ hour_ts: HOUR, samples: 0, latency_sum: 0 }),
      row({ hour_ts: 0, latency_sum: 60 * 20 }),
    ]);
    expect(points).toEqual([
      { ts: 0, avg: 20 },
      { ts: 2 * HOUR, avg: 30 },
    ]);
  });
});

describe("LatencyChart", () => {
  it("captions peak from the plotted series, not the slowest assertion's max", () => {
    // The line is the cross-assertion weighted average; a peak taken from raw
    // latency_max would sit far above anything the chart draws.
    const { container } = render(
      React.createElement(LatencyChart, {
        rows: [
          row({ probe: "livez", latency_sum: 60 * 10, latency_max: 40 }),
          row({ probe: "healthz", latency_sum: 60 * 300, latency_max: 900 }),
          row({ hour_ts: HOUR, probe: "livez", latency_sum: 60 * 8, latency_max: 35 }),
          row({ hour_ts: HOUR, probe: "healthz", latency_sum: 60 * 100, latency_max: 700 }),
        ],
      }),
    );
    // Hour averages: (10+300)/2 = 155, (8+100)/2 = 54 → peak 155, not 900.
    expect(container.textContent).toContain("peak 155ms");
    expect(container.textContent).toContain("avg 54ms");
  });

  it("draws a flat baseline instead of NaN coordinates when every average is 0", () => {
    // Instant failures roll up as samples > 0 with latency_sum 0; an all-zero
    // window must not divide by a zero scale.
    const { container } = render(
      React.createElement(LatencyChart, {
        rows: [row({ latency_sum: 0 }), row({ hour_ts: HOUR, latency_sum: 0 })],
      }),
    );
    const paths = [...container.querySelectorAll("path")];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.getAttribute("d")).not.toContain("NaN");
    }
  });
});
