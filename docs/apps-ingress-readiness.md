# Working note — App (SPA) ingress-readiness monitoring

Status: **design agreed, implementation deferred.** Paused here to ship + test the
first live service. This note is the resume point.

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
optional content assertions**, defaulting to today's 2xx-only behavior so every existing
service probe is untouched:

- `expect_content_type` (e.g. `text/html`)
- `expect_body_contains` (substring marker in the shell)
- `expect_json` (field match, e.g. `app == "flint"`)

Then extend the Zod probe schema in `worker/src/topology.ts` to accept these optional
assertion fields, and add `kind: service | app` to the component schema (default
`service`).

## Deliberately deferred (even within Option A)

- **Asset-graph walk** — parse `index.html`, HEAD each hashed bundle. The deep-route
  shell check already catches the common broken-deploy case; HTML parsing in the worker
  is extra surface for later.
- **Anything requiring JS execution** — that's the synthetic pile.

## Current state / next steps

- ✅ First live service wired: `tenants` → **Accounts & Billing**, global component,
  `http://tenants.svc.prd.wardnet.network:81/{livez,readyz,healthz}`. All three probes
  confirmed returning 200 (healthz reports `jwt_keys`, `listener`, `stripe`). Topology
  validated; this is the change to merge + test.
- ⏭️ Next session: implement Option A — assertion-aware `executeProbe`, `kind` +
  assertion fields in the topology schema, then add the first app entry with its two
  probes.
