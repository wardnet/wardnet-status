# wardnet-status

Uptime monitoring and public status page for wardnet-cloud, running entirely on
the Cloudflare free tier. Design rationale: [docs/adr/0001](docs/adr/0001-custom-typescript-monitor-on-cloudflare.md);
vocabulary: [CONTEXT.md](CONTEXT.md).

- **Prober** — one Durable Object per region (+ `global`), driven by a 1-minute
  cron, probing each component's `livez` / `readyz` / `healthz` endpoints from
  a location-hinted vantage.
- **Topology is data** — [`topology.yaml`](topology.yaml) is fetched from
  `main` at runtime (ETag-cached, last-known-good fallback). Adding a region,
  component, or probe is a merge; no deploy.
- **Status ladder** — per probe: 1 failure → UP (blip), 2 → DEGRADED, 3+ → DOWN;
  2 successes → UP. `healthz` (and slowness) cap at DEGRADED; `livez`/`readyz`
  can drive DOWN.
- **History** — D1, tiered: raw 14 d, hourly rollups 90 d, daily rollups and
  incidents forever.
- **Incidents** — one per episode: D1 row + auto-managed GitHub issue in this
  repo (opened at DEGRADED, escalated at DOWN, closed with a timeline on
  recovery; 10-minute re-open window).
- **Notifications** — Telegram + ntfy on status transitions only.
- **Watchdog** — healthchecks.io dead-man's switch pinged after each successful
  cycle, alerting from outside both Cloudflare and Hetzner.
- **Page** — React/Vite SPA on the Wardnet Forge design system
  (`@wardnet/ui` + `@wardnet/styles`), served as static assets by the same
  Worker at [status.wardnet.network](https://status.wardnet.network).

## Local development

```sh
export NODE_AUTH_TOKEN="$(gh auth token)"   # needs read:packages (@wardnet registry)
pnpm install

# Page against MSW fixtures — fully offline, no worker needed:
pnpm dev:page
#   scenarios: ?scenario=operational|degraded|down-incident|stale-config|cold-start

# Full stack: worker (local D1 + miniflare) + page proxying /api to it:
cp worker/.dev.vars.example worker/.dev.vars # TOPOLOGY_URL=demo → bundled demo
                                             # topology probing real public sites
pnpm --filter @wardnet/status-worker migrate:local
pnpm dev:worker                              # :8787, cron testable
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # fire one probe cycle
VITE_ENABLE_MSW=false pnpm dev:page          # /api proxied to :8787

pnpm test          # worker unit tests + page component tests
pnpm type-check
```

## First deploy checklist

1. `wrangler d1 create wardnet-status` → paste the id into
   `worker/wrangler.jsonc` (`database_id`).
2. Confirm the real `<service>.svc.<…>` health FQDNs in `topology.yaml`
   (see the TODO there) and that nginx `:81` is reachable publicly.
3. Repo secrets (Actions): `CLOUDFLARE_API_TOKEN` (Workers + D1 edit),
   `TELEGRAM_BOT_TOKEN`, `NTFY_TOPIC`, `GH_ISSUES_TOKEN` (fine-grained PAT,
   this repo only, issues RW), `HEALTHCHECKS_PING_URL`.
4. Create one healthchecks.io check per region (`<url>/global`, `<url>/use1`),
   schedule "every 1 min, grace 5 min", with Telegram/ntfy integrations.
5. Push to `main` — `.github/workflows/deploy.yml` tests, migrates, pushes
   secrets, and deploys. The custom domain `status.wardnet.network` binds on
   first deploy (zone must be on the same Cloudflare account).

## Repo layout

```
topology.yaml    what to monitor (runtime data)
worker/          prober DOs, evaluator, incidents, notifiers, JSON API
page/            status page SPA (+ MSW mocks for offline dev)
docs/adr/        decisions
```
