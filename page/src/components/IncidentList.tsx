import { Card, CardContent, CardHeader, CardTitle, Text, TextLink } from "@wardnet/ui";
import type { Incident } from "../api/types";
import { StatusPill } from "./StatusPill";

const GITHUB_REPO = "wardnet/wardnet-status";

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function duration(inc: Incident): string | null {
  if (!inc.resolved_at) return null;
  const mins = Math.round((inc.resolved_at - inc.started_at) / 60_000);
  return mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins} min`;
}

export function IncidentList({ incidents }: { incidents: Incident[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Incident history</CardTitle>
      </CardHeader>
      <CardContent>
        {incidents.length === 0 ? (
          <Text variant="body" color="ink-2">
            No incidents recorded.
          </Text>
        ) : (
          <ul className="incident-list">
            {incidents.map((inc) => {
              const where = inc.region === "global" ? inc.component : `${inc.component} (${inc.region})`;
              const probes = (JSON.parse(inc.probes_failing) as string[]).join(", ");
              return (
                <li key={inc.id} className="incident-row">
                  <StatusPill
                    status={inc.resolved_at ? "UP" : inc.severity}
                    label={inc.resolved_at ? "Resolved" : undefined}
                  />
                  <div className="incident-body">
                    <Text variant="body-strong">{where}</Text>
                    <Text variant="caption" color="ink-3">
                      <span className="mono">{fmt(inc.started_at)}</span>
                      {duration(inc) && (
                        <>
                          {" · "}
                          <span className="mono">{duration(inc)}</span>
                        </>
                      )}
                      {probes && <> · probes: <span className="mono">{probes}</span></>}
                      {inc.github_issue !== null && (
                        <>
                          {" · "}
                          <TextLink href={`https://github.com/${GITHUB_REPO}/issues/${inc.github_issue}`}>
                            #{inc.github_issue}
                          </TextLink>
                        </>
                      )}
                    </Text>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
