# ADR 0001 — Custom TypeScript monitor on Cloudflare, not a reused tool or Hetzner

## Status
Accepted (2026-07-04)

## Context
wardnet-cloud has no uptime monitoring, status page, or incident tooling. The
services run on Hetzner via inforge; Cloudflare (DNS, R2) and Grafana Cloud
(OTLP, free tier) are already in the stack. Requirements: per-region probing of
livez/readyz/healthz, stored history, public status page, and on down/degraded —
notification plus an auto-opened incident.

Alternatives evaluated:
- **Gatus**: covers everything via YAML (incl. GitHub-issue incidents) but needs
  a VM. Running it on Hetzner shares the blast radius with the monitored
  services; running elsewhere costs money and adds a pet server.
- **Upptime**: zero infra, but GitHub Actions cron caps granularity at ~5 min
  and probes only from GitHub's runners.
- **Grafana Cloud Synthetics (free tier)**: 100k executions/month ≈ a handful of
  checks at 5-min from one location; weak public status page; no better
  granularity than Upptime.
- **UptimeFlare**: closest fit (Cloudflare free tier, 1-min checks) but has no
  monitor grouping and a non-configurable page — the regions→components UI
  would have to be rebuilt anyway, hollowing out the value of the fork.
- **Language**: Go on Workers has no official support (ruled out). Rust
  (workers-rs) is officially supported but adds WASM friction for a prober that
  is ~90% I/O orchestration; the page is TypeScript regardless.

## Decision
Build a small custom system in **TypeScript on the Cloudflare free tier**:
per-region Durable Objects (locationHint vantage, best-effort) probing every
minute, D1 for tiered history, one Worker serving both the JSON API and the
status page (Wardnet Forge design system), Telegram/ntfy notifications, GitHub
issues as incidents, and a healthchecks.io dead-man's switch as the watchdog.
Topology is runtime data (`topology.yaml` fetched from `main`), never baked
into deploys.

## Consequences
- $0 to run; 1-minute checks; monitoring is fate-independent of Hetzner but
  fate-shares with Cloudflare (accepted; the watchdog sits outside both).
- We own the evaluator, rollups, page, and incident lifecycle — small but real
  maintenance surface that a reused tool would have carried for us.
- Adding regions/components/probes is a data merge with no redeploy.
- Multi-instance readiness semantics, if ever needed, are a one-line evaluator
  change (readyz failures currently mean "no healthy node answered" → DOWN).
