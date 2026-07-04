import { Card, CardContent, CardHeader, CardTitle, Text } from "@wardnet/ui";
import type { ComponentStatus, DailyRow, HourlyRow } from "../api/types";
import { LatencyChart } from "./LatencyChart";
import { StatusPill } from "./StatusPill";
import { UptimeBars } from "./UptimeBars";

export function ComponentCard({
  component,
  region,
  daily,
  hourly,
}: {
  component: ComponentStatus;
  region: string;
  daily: DailyRow[];
  hourly: HourlyRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <div className="component-head">
          <CardTitle>{component.display_name}</CardTitle>
          <StatusPill status={component.status} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="probe-row">
          {component.probes.map((p) => (
            <div className="probe" key={p.name}>
              <Text variant="caption" color="ink-3">
                <span className="mono">/{p.name}</span>
              </Text>
              <StatusPill status={p.status} />
              {p.latency_ms !== null && (
                <Text variant="caption" color="ink-3">
                  <span className="mono">{p.latency_ms}ms</span>
                </Text>
              )}
            </div>
          ))}
        </div>
        <UptimeBars rows={daily.filter((r) => r.region === region && r.component === component.name)} />
        <LatencyChart rows={hourly.filter((r) => r.region === region && r.component === component.name)} />
      </CardContent>
    </Card>
  );
}
