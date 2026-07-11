import { Text } from "@wardnet/ui";
import type { DailyRow } from "../api/types";

/**
 * The classic 90-day uptime strip: one cell per UTC day, worst status wins the
 * cell's tone. Colors come from tokens only (Forge rule: no new hex).
 */
export function UptimeBars({
  days,
  rows,
}: {
  days?: number;
  rows: DailyRow[]; // pre-filtered to one component, any probes
}) {
  const window = days ?? 90;
  const now = Date.now();
  const today = now - (now % 86_400_000);

  const byDay = new Map<number, { up: number; degraded: number; down: number; samples: number }>();
  for (const r of rows) {
    const agg = byDay.get(r.day_ts) ?? { up: 0, degraded: 0, down: 0, samples: 0 };
    agg.up += r.up;
    agg.degraded += r.degraded;
    agg.down += r.down;
    agg.samples += r.samples;
    byDay.set(r.day_ts, agg);
  }

  const cells = Array.from({ length: window }, (_, i) => {
    const day = today - (window - 1 - i) * 86_400_000;
    const agg = byDay.get(day);
    if (!agg || agg.samples === 0) return { day, tone: "var(--line)", pct: null as number | null };
    const tone =
      agg.down > 0 ? "var(--danger)" : agg.degraded > 0 ? "var(--warn)" : "var(--accent)";
    return { day, tone, pct: (agg.up / agg.samples) * 100 };
  });

  const overall = (() => {
    let up = 0;
    let samples = 0;
    for (const agg of byDay.values()) {
      up += agg.up;
      samples += agg.samples;
    }
    return samples ? ((up / samples) * 100).toFixed(2) : null;
  })();

  return (
    <div className="uptime">
      <div className="uptime-bars" role="img" aria-label={`Uptime, last ${window} days`}>
        {cells.map((c) => (
          <span
            key={c.day}
            className="uptime-cell"
            style={{ background: c.tone }}
            title={
              c.pct === null
                ? `${new Date(c.day).toISOString().slice(0, 10)} — no data`
                : `${new Date(c.day).toISOString().slice(0, 10)} — ${c.pct.toFixed(2)}% up`
            }
          />
        ))}
      </div>
      {overall !== null ? (
        <div className="uptime-legend">
          <Text variant="caption" color="ink-3">
            {window} days ago
          </Text>
          <span className="uptime-legend-rule" />
          <Text variant="caption" color="ink-3">
            <span className="mono">{overall}%</span> uptime
          </Text>
          <span className="uptime-legend-rule" />
          <Text variant="caption" color="ink-3">
            Today
          </Text>
        </div>
      ) : (
        <Text variant="caption" color="ink-3">
          Collecting…
        </Text>
      )}
    </div>
  );
}
