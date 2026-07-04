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
A component exposes one or more probes. A component's status is the worst of
its probes' statuses.

## Probe
A named URL health check of a component. The vocabulary is closed — exactly
three, each optional:
- **livez** — the process is alive; zero dependencies.
- **readyz** — the component can serve right now; critical-path dependencies only.
- **healthz** — aggregate health including non-critical indicators.

## Status
The state of a probe/component/region: **UP**, **DEGRADED**, **DOWN**, or
**UNKNOWN** (no fresh evaluation). Severity order: DOWN > DEGRADED > UP.
Statuses escalate UP → DEGRADED → DOWN via consecutive failures and return
directly to UP on confirmed recovery. livez/readyz failures can drive DOWN;
healthz failures cap at DEGRADED (a component with livez+readyz passing is
demonstrably serving). Slowness contributes DEGRADED only.

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
