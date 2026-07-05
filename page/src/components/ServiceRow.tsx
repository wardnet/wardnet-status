import * as React from "react";
import { Text } from "@wardnet/ui";
import type { ComponentStatus, DailyRow, HourlyRow, Incident } from "../api/types";
import { IncidentRows } from "./IncidentList";
import { LatencyChart } from "./LatencyChart";
import { StatusPill } from "./StatusPill";
import { UptimeBars } from "./UptimeBars";

/**
 * One compact line per service inside a region card: name, aggregated status,
 * 90-day uptime strip. Latency chart + this service's incident story live
 * behind the Details toggle — the collapsed page stays scannable.
 */
export function ServiceRow({
  component,
  region,
  daily,
  hourly,
  incidents,
}: {
  component: ComponentStatus;
  region: string;
  daily: DailyRow[];
  hourly: HourlyRow[];
  incidents: Incident[];
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="service-row">
      <div className="service-head">
        <Text variant="body-strong">{component.display_name}</Text>
        <span className="service-head-spacer" />
        <StatusPill status={component.status} />
        <button
          type="button"
          className="service-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      <UptimeBars rows={daily.filter((r) => r.region === region && r.component === component.name)} />
      {open && (
        <div className="service-details">
          <LatencyChart rows={hourly.filter((r) => r.region === region && r.component === component.name)} />
          <Text variant="caption" color="ink-3">
            Incidents
          </Text>
          <IncidentRows
            incidents={incidents.filter((i) => i.region === region && i.component === component.name)}
          />
        </div>
      )}
    </div>
  );
}
