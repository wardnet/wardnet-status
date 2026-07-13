# wardnet-status — Glossary

Canonical terms for this context. Implementation details do not belong here.

## Topology Config
The declarative description of everything the monitor watches: regions, their
components, and each component's probes. Lives as `topology.yaml` on `main` of
this repository and is consumed as **data at runtime** — changing it never
requires a deploy.

## Region
A deployment location of wardnet-cloud, identified by the same slug as
`wardnet-infrastructure` `regions.yaml` (e.g. `use1`). A region groups
components. **Global** is the pseudo-region for components that exist once
rather than per region (e.g. tenants).

## Component
A monitorable service within a region (or global): tenants, ddns, tunneller.
A component declares one or more assertions. A component's status is the worst
of its assertions' statuses. A component is ONE line on the status page — every
path to the same service (direct health port, via the API gateway) is an
assertion on that one component, never a second component.

## Assertion
A named endpoint check of a component: a URL, the HTTP status that counts as
"ok" (default any 2xx; 502/503/504 always fail), an optional check kind
(`http` | `spa`), and an impact policy — the severity ceiling the assertion
alone may drive (`down`, the default, or `degraded`). Names are free-form but
must be unique per component and STABLE (history is keyed by them).
Conventional names:
- **livez** — the process is alive; zero dependencies.
- **readyz** — the component can serve right now; critical-path dependencies only.
- **healthz** — aggregate health including non-critical indicators; declared
  with `impact: degraded`.
- **gateway** — the component as reached over the consumer path (through the
  public API gateway) rather than the direct health port.

## Status
The state of an assertion/component/region: **UP**, **DEGRADED**, **DOWN**, or
**UNKNOWN** (no fresh evaluation). Severity order: DOWN > DEGRADED > UP.
Statuses escalate UP → DEGRADED → DOWN via consecutive failures (thresholds
overridable per assertion) and return directly to UP on confirmed recovery.
An assertion's declared impact caps how far it can drive the component:
`impact: degraded` failures cap at DEGRADED (a component whose other
assertions pass is demonstrably serving). Slowness contributes DEGRADED only.

## Episode
One continuous arc of a single component in a single region from leaving UP
until returning to UP. An episode has exactly one Incident.

## Incident
The record of an episode: opened when the component enters DEGRADED, escalated
if it reaches DOWN, resolved when it returns to UP. Materialized both in the
status database (drives the page) and as a GitHub issue in this repository.
A component re-entering DEGRADED/DOWN within the re-open window (10 minutes)
re-opens the previous incident rather than creating a new one.

## Watchdog
The external dead-man's switch (healthchecks.io) that alerts when the prober
itself stops reporting — monitoring for the monitor, hosted outside both
Cloudflare and Hetzner.
