import { Text } from "@wardnet/ui";
import type { HourlyRow } from "../api/types";

/**
 * Response-time-over-time line, per Forge chart rules: soft-fill area, one
 * accent series, 4 dashed horizontal hairlines, mono y-labels, no vertical
 * grid, "Collecting…" empty state (never a flat-zero line).
 */
export function LatencyChart({ rows }: { rows: HourlyRow[] }) {
  const points = rows
    .filter((r) => r.samples > 0)
    .map((r) => ({ ts: r.hour_ts, avg: r.latency_sum / r.samples }))
    .sort((a, b) => a.ts - b.ts);

  if (points.length < 2) {
    return (
      <Text variant="caption" color="ink-3">
        Collecting…
      </Text>
    );
  }

  const W = 560;
  const H = 96;
  const PAD = 4;
  const maxY = Math.max(...points.map((p) => p.avg)) * 1.15;
  const minTs = points[0]!.ts;
  const maxTs = points[points.length - 1]!.ts;
  const x = (ts: number) => PAD + ((ts - minTs) / (maxTs - minTs)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / maxY) * (H - 2 * PAD);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p.avg).toFixed(1)}`).join(" ");
  const area = `${line} L${x(maxTs).toFixed(1)},${H - PAD} L${x(minTs).toFixed(1)},${H - PAD} Z`;
  const gridYs = [0.25, 0.5, 0.75, 1].map((f) => H - PAD - f * (H - 2 * PAD));

  return (
    <div className="latency-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Average response time, last 48 hours">
        {gridYs.map((gy) => (
          <line key={gy} x1={PAD} x2={W - PAD} y1={gy} y2={gy} stroke="var(--line)" strokeDasharray="2 4" strokeWidth="1" />
        ))}
        <path d={area} fill="var(--accent)" opacity="0.12" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      </svg>
      <Text variant="caption" color="ink-3">
        avg <span className="mono">{Math.round(points[points.length - 1]!.avg)}ms</span> · peak{" "}
        <span className="mono">{Math.round(Math.max(...rows.map((r) => r.latency_max)))}ms</span> · 48h
      </Text>
    </div>
  );
}
