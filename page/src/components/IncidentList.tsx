import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, Text, TextLink } from "@wardnet/ui";
import type { Incident } from "../api/types";
import { StatusPill } from "./StatusPill";

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function duration(inc: Incident): string | null {
  if (!inc.resolved_at) return null;
  const mins = Math.round((inc.resolved_at - inc.started_at) / 60_000);
  return mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins} min`;
}

function IncidentRow({ incident: inc }: { incident: Incident }) {
  const [showReport, setShowReport] = React.useState(false);
  const where = inc.region === "global" ? inc.component : `${inc.component} (${inc.region})`;

  return (
    <li className="incident-row">
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
          {inc.github_issue !== null && inc.github_url !== null && (
            <>
              {" · "}
              <TextLink href={inc.github_url}>issue #{inc.github_issue}</TextLink>
            </>
          )}
          {inc.report && (
            <>
              {" · "}
              <button
                type="button"
                className="incident-report-toggle"
                aria-expanded={showReport}
                onClick={() => setShowReport((v) => !v)}
              >
                {showReport ? "hide description" : "description"}
              </button>
            </>
          )}
        </Text>
        {showReport && inc.report && <pre className="incident-report">{inc.report}</pre>}
      </div>
    </li>
  );
}

/** The bare incident rows — reused by the global history card and per-service details. */
export function IncidentRows({ incidents }: { incidents: Incident[] }) {
  if (incidents.length === 0) {
    return (
      <Text variant="body" color="ink-2">
        No incidents recorded.
      </Text>
    );
  }
  return (
    <ul className="incident-list">
            {incidents.map((inc) => (
              <IncidentRow key={inc.id} incident={inc} />
            ))}
    </ul>
  );
}

export function IncidentList({ incidents }: { incidents: Incident[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Incident history</CardTitle>
      </CardHeader>
      <CardContent>
        <IncidentRows incidents={incidents} />
      </CardContent>
    </Card>
  );
}
