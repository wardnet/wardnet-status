# Working note — consumer-path monitoring (SPA ingress-readiness + API-gateway edge)

Status: **design agreed, implementation deferred.** Paused here to ship + test the
first live service. This note is the resume point.

> **Superseded in part (2026-07-13):** the "separate `tenants-edge` component"
> decision below was reversed once it shipped — two page lines for one service
> proved confusing and doubled incidents. The probe vocabulary was generalized to
> per-component **assertions** (free-form named checks with a declared `impact`
> ceiling), and the gateway check is now the `gateway` assertion on `tenants`
> itself. Fault localization moved from component level to assertion level
> (incident reports name the failing assertion). See CONTEXT.md "Assertion".

Two related gaps, one shared enabler. Today we probe services at their **back door**
(direct `:81` health endpoints). This note covers two ways to also probe the
**front door** — the path real consumers use:
1. **SPA ingress-readiness** — React apps served through our nginx ingress.
2. **API-gateway edge** — backend services reached through the API GW, not directly.

Both ride on the same load-bearing change: **assertion-aware probes** (`expect_status`
et al.), so implementing one nearly gives the other for free.

## Problem

We monitor backend **services** today (`livez`/`readyz`/`healthz`, each a bare 2xx
URL check). We also want to monitor our **web apps** (React SPAs), which are served
**through our nginx ingress** (not Cloudflare). A plain `GET / → 200` is nearly
meaningless for a SPA: the shell returns 200 even when the deploy is broken or the
ingress routes to the wrong backend.

What we actually want to prove is **the ingress is doing its job for the SPA**.

## Framing decisions

- The k8s liveness/readiness/health triad does **not** map onto a static SPA:
  - *liveness* collapses into the `GET / → 200` we already have (no process to restart).
  - *readiness* = "does the ingress serve the correct app correctly right now" — **this
    is the real, browser-free gap we're closing.**
  - *health* = "the JS actually boots/renders" — requires executing JS = **synthetic
    testing = explicitly postponed.**
- **Synthetic testing is postponed** (kept internal anyway; not what companies expose).
  This feature is strictly the non-synthetic, HTTP-only readiness layer.

## The probe model for an app (two assertions, both plain HTTP)

| Assertion | Request | Pass condition | Catches |
|---|---|---|---|
| Backend identity | `GET /version.json` | 200 + expected `app`/`sha` | wrong-backend, no-backend, stale deploy |
| SPA fallback | `GET /<random-deep-path>` | 200 + **HTML shell** (content-type/body) | broken ingress catch-all routing (deep links 404) |

The SPA-fallback probe is the important one: it's the classic nginx-ingress SPA bug
(`try_files … /index.html` missing) that a root-path 200 check cannot see.

Recommended: each SPA publishes a build-stamped `version.json`
(`{ "app": "...", "sha": "...", "builtAt": "..." }`) as a static asset. Fetched through
the ingress it proves the whole chain: ingress → service → pod → correct app version.

## Architecture decision — **Option A** (chosen)

An **app is just a component with `kind: app`** in the existing `components[]` list.
It **reuses the `livez/readyz/healthz` status ladder** and the entire downstream
pipeline (evaluator, incidents, storage, region-card page) unchanged. App probes map
onto the existing names with assertions bolted on (e.g. `readyz` = deep-route→shell,
`livez` = version.json→identity).

Rejected Option B (separate `apps[]`/`services[]` collections with app-specific probe
names): cleaner YAML vocabulary, but forks schema/storage/rendering into two shapes for
no pipeline benefit.

## The load-bearing code change

Topology is the easy part. The crux is **teaching `executeProbe` (worker/src/prober.ts)
optional assertions**, defaulting to today's 2xx-only behavior so every existing service
probe is untouched:

- `expect_status` (e.g. `401` for the API-gateway edge check — the code the *service*
  returns through the GW; also lets a check accept a non-2xx as healthy)
- `expect_content_type` (e.g. `text/html`)
- `expect_body_contains` (substring marker in the shell)
- `expect_json` (field match, e.g. `app == "flint"`)

**Guardrail:** `502/503/504` and timeouts must **always fail** regardless of
`expect_status` — through a gateway/ingress those specifically mean "upstream
unreachable," the exact failure these checks exist to catch, so they must never be
whitelisted by a loose `expect_status`.

Then extend the Zod probe schema in `worker/src/topology.ts` to accept these optional
assertion fields, and add `kind: service | app` to the component schema (default
`service`).

## API-gateway edge monitoring (consumer path for services)

**Gap:** service probes hit the service's back door (direct `:81`). Consumers hit the
**API GW**. The two fail independently — a green direct health check with a broken GW
hop = "green dashboard, angry customers." We want to also probe *through* the GW.

**Key fact about our setup:** our API GW is a **lightweight nginx doing routing only —
no auth.** So a `401` on an auth-protected endpoint **comes from the service itself,
through the GW.** That makes the 401 a genuine **end-to-end signal**: DNS → nginx →
routing → *upstream service reached* → service's own auth answered. (The usual gotcha —
gateways rejecting auth at the edge *before* proxying upstream, so a 401 proves nothing
about upstream — does **not** apply to us, because our GW doesn't do auth.)

**Design (agreed):**

- Probe consumer endpoint(s) through the GW, asserting the expected status
  (`expect_status: 401` for us). `2xx`/`401` → healthy; `5xx`/`502`/`503`/`504`/timeout
  → the upstream-unreachable failure we're catching.
- Model it as a **separate component** — e.g. `tenants-edge` /
  "Identity & Billing (via gateway)" — **not** extra probes crammed onto the closed
  `livez/readyz/healthz` triad. Two reasons: (1) the GW check is a different *vantage*
  (external, through the edge), and (2) a separate component **localizes the fault** —
  direct `:81` UP + edge DOWN tells you "service healthy, edge/routing broken," which is
  the whole point.
- **Failure drives the existing ladder**, not an instant hard-DOWN: 1 fail = UP, 2 =
  DEGRADED, 3+ = DOWN, slow-but-correct = DEGRADED. Worst-wins aggregation already gives
  the "any endpoint fails → component down" behavior without special-casing.
- Prefer endpoints with a **stable status** — `expect: 401` pins you to that endpoint
  keeping its 401; if it's made public or the route is removed, the probe breaks. A
  deterministic route is nicer where available.

**Open decision — endpoint count:**

- **1–3 representative endpoints per service** → fits the current triad on one edge
  component, minimal change (just `expect_status`). **Recommended starting point** — one
  representative 401 check already catches GW-down / route-broken / upstream-unreachable,
  ~90% of the value.
- **Many arbitrary consumer endpoints** (catch one misrouted path among dozens) → the
  fixed 3-name triad won't hold them; would need a **flexible named-check list**
  `{ path, expect_status }` on edge components, worst-wins. Bigger schema change — only
  graduate to this if a single-route failure actually slips past the representative check.

## Deliberately deferred (even within Option A)

- **Asset-graph walk** — parse `index.html`, HEAD each hashed bundle. The deep-route
  shell check already catches the common broken-deploy case; HTML parsing in the worker
  is extra surface for later.
- **Anything requiring JS execution** — that's the synthetic pile.

## Current state / next steps

- ✅ First live service **deployed and monitored**: `tenants` → **Identity & Billing**,
  global component, `http://tenants.svc.prd.wardnet.network:81/{livez,readyz,healthz}`.
  All three probes UP in production (healthz reports `jwt_keys`, `listener`, `stripe`).
  Status page live at https://status.wardnet.network (custom domain, D1, cron, Grafana
  IRM paging, healthchecks.io dead-man's switch all wired).
- ⏭️ Next session: implement the shared enabler — assertion-aware `executeProbe`
  (`expect_status` first, it unlocks both features), plus `kind` + assertion fields in
  the topology schema. Then:
  - **API-gateway edge** — add a `tenants-edge` component with the 401-through-GW check
    (simplest first win, one representative endpoint).
  - **SPA ingress-readiness** — add the first `kind: app` entry with its two probes.
