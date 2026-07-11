import * as React from "react";
import { Banner, Card, CardContent, CardHeader, CardTitle, Heading, Logo, Text, ThemeToggle } from "@wardnet/ui";
import { fetchHistory, fetchIncidents, fetchStatus } from "./api/client";
import type { HistoryResponse, Incident, StatusResponse } from "./api/types";
import { IncidentList } from "./components/IncidentList";
import { ServiceRow } from "./components/ServiceRow";
import { StatusPill } from "./components/StatusPill";
import { useTheme } from "./theme/useTheme";

const REFRESH_MS = 30_000;

const OVERALL_COPY = {
  UP: "All systems operational",
  DEGRADED: "Partial degradation",
  DOWN: "Service outage",
  UNKNOWN: "Awaiting first probes",
} as const;

export function App() {
  const { theme, toggle } = useTheme();
  const [status, setStatus] = React.useState<StatusResponse | null>(null);
  const [history, setHistory] = React.useState<HistoryResponse>({ hourly: [], daily: [] });
  const [incidents, setIncidents] = React.useState<Incident[]>([]);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [s, h, i] = await Promise.all([fetchStatus(), fetchHistory(), fetchIncidents()]);
        if (!live) return;
        setStatus(s);
        setHistory(h);
        setIncidents(i.incidents);
        setError(false);
      } catch {
        if (live) setError(true);
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const lastProbe = status
    ? Math.max(0, ...status.regions.map((r) => r.last_cycle ?? 0)) || null
    : null;

  return (
    <div className="page">
      <header className="page-head">
        <div className="brand">
          <Logo height={32} variant={theme === "dark" ? "dark" : "light"} />
          <Heading level={1}>Status</Heading>
        </div>
        <ThemeToggle theme={theme} onToggle={toggle} />
      </header>

      {error && (
        <Banner tone="warn" role="alert">
          Status data is unreachable. Retrying…
        </Banner>
      )}

      {status && (
        <>
          {status.config_stale && (
            <Banner tone="warn" role="status">
              Monitoring topology is stale — probing with the last known good configuration.
            </Banner>
          )}
          {status.incidents.length > 0 && (
            <Banner tone={status.overall === "DOWN" ? "down" : "warn"} role="alert">
              Active incident: {status.incidents
                .map((i) => (i.region === "global" ? i.component : `${i.component} (${i.region})`))
                .join(", ")}
            </Banner>
          )}

          <section className="overall">
            <StatusPill status={status.overall} label={OVERALL_COPY[status.overall]} />
            {lastProbe && (
              <Text variant="caption" color="ink-3">
                last probe <span className="mono">{new Date(lastProbe).toISOString().slice(11, 16)} UTC</span>
              </Text>
            )}
          </section>

          {status.regions.map((region) => (
            <Card key={region.slug}>
              <CardHeader>
                <div className="region-head">
                  <CardTitle>{region.display_name}</CardTitle>
                  <StatusPill status={region.status} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="service-list">
                  {region.components.map((component) => (
                    <ServiceRow
                      key={component.name}
                      component={component}
                      region={region.slug}
                      daily={history.daily}
                      hourly={history.hourly}
                      incidents={incidents}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}

          <IncidentList incidents={incidents} />
        </>
      )}
    </div>
  );
}
