# 2. Proposed architecture

## 2.1 Deployment

```
                    ┌──────────────── Cloudflare ────────────────┐
                    │  DNS (managed records)   Tunnel A  Tunnel B │
                    └──────▲───────────────────────▲─────────▲───┘
                           │ API (HTTPS)           │         │
┌──── Controller VM (Docker Compose) ────┐         │         │
│  nginx (TLS) ─► fsm-server (Fastify)   │   ┌─────┴───┐ ┌───┴─────┐
│                 ├─ REST API + UI        │   │ Site A  │ │ Site B  │
│                 ├─ Health engine        │◄──┤ PVE/NPM │ │ PVE/NPM │
│                 ├─ Orchestrator         │SD-│ apps    │ │ apps    │
│                 └─ Providers            │WAN└─────────┘ └─────────┘
│  postgres                               │
└─────────────────────────────────────────┘
```

One Compose stack, three containers: `nginx` (TLS termination, static UI,
reverse proxy to the API), `server` (Node 22 + Fastify, also runs the health
engine in-process) and `postgres`. **No Redis**: the health engine is an
in-process scheduler and operations are serialised with PostgreSQL advisory
locks, so a queue adds infrastructure without buying safety. If a later phase
needs multiple controller replicas, leader election will use the same
advisory-lock mechanism.

## 2.2 Layers

```
web (React/TS/Vite)            – NOC dashboard, config screens, event log
   │ JSON over HTTPS, session cookie + CSRF header
api (Fastify routes)           – authn/z, validation (TypeBox → OpenAPI), rate limits
   │
orchestrator                   – readiness evaluation, failover / dry-run runner
   │        └── state machines – pure transition tables, persisted with versioning
health engine                  – scheduler, check executors, threshold evaluator, aggregator
   │
providers                      – CloudflareProvider, TunnelProvider, ProxmoxProvider,
   │                              NpmProvider, Notifier (Phase 2)
http client                    – single egress point: timeouts, TLS pinning, host allow-list,
   │                              secret redaction in errors
repositories (pg)              – SQL, migrations, audit log (append-only)
```

Rules that keep this safe:

* **Providers never decide.** They expose typed read methods and narrowly-scoped
  mutation methods (`updateDnsRecord`, `startVm`, `enableProxyHost`). Only the
  orchestrator calls mutation methods, and only through a `ChangeExecutor` that
  writes an audit event *before* (intent) and *after* (result) each change.
* **Dry-run is enforced structurally.** A dry-run operation gets a
  `ChangeExecutor` in plan mode: it records "would do X" and never calls the
  provider mutation. Mutation methods are not reachable from check code.
* **The state machines are pure.** `transition(state, event) → state | error`
  is a table with no I/O, so it can be exhaustively unit tested; persistence
  wraps it with an optimistic version check and writes a transition row.
* **Everything is configured in the database**, edited via UI/API. Environment
  variables hold only bootstrapping values: DB URL, master encryption key,
  initial admin, egress allow-list, listen address.

## 2.3 Health model

```
HealthCheck (type, path, independence_group, category, target)
   │ executes every interval → CheckResult(ok, latency, message, observed)
   ▼
Threshold evaluator (per check, policy thresholds)
   OK → WARNING (1..N-1 consecutive failures)
      → DEGRADED (≥N failures but < min duration)
      → FAILED (≥N failures AND failing ≥ min duration)
   FAILED/DEGRADED → OK only after M consecutive successes
   ▼
Aggregator
   site health        = f(site-scoped network/infrastructure checks)
   tunnel health      = f(tunnel checks)            (separate!)
   application health = f(app checks on that site)  (per app, per site)
   replication health = f(replication age vs app limit)
   traffic health     = f(tunnel + NPM + public HTTPS for the active site)
   ▼
Site failure confirmation (policy)
   FAILED in ≥ K distinct independence groups
   (+ optional: at least one failing group off the SD-WAN path)
```

Each aggregate carries `reasons[]`, human-readable lines such as
"Site A HTTP + TCP + Proxmox checks failed (3 independent groups)", which feed
the event log and the readiness panel.

## 2.4 Readiness ("If Site A disappeared right now, can I move to Site B?")

`ReadinessService.evaluate(target = B)` returns:

```json
{
  "ready": false,
  "verdict": "FAILOVER NOT SAFE",
  "items": [
    {"key":"proxmox.B","status":"PASS","message":"Proxmox healthy (node pve-b online)"},
    {"key":"replication.nextcloud","status":"FAIL","message":"Nextcloud replication is 47 minutes old (limit 15)","overridable":true},
    {"key":"npm.B.wordpress","status":"FAIL","message":"NPM configuration mismatch: forward_host 10.2.0.20 ≠ expected 10.2.0.21"}
  ],
  "estimatedMaxDataLossSeconds": 2820
}
```

It is computed from the latest health state (cheap, used by the dashboard
every few seconds) and recomputed with fresh live calls at the start of every
dry-run or failover.

## 2.5 Provider details

| Provider | API | Auth | Phase 1 capabilities |
|---|---|---|---|
| Cloudflare | `api.cloudflare.com/client/v4` | API token (Bearer) | token verify, zone discovery, DNS list/get/create/update/delete, record validation |
| Tunnel | Cloudflare `accounts/:id/cfd_tunnel` | same token | tunnel status, connection count, remote ingress config |
| Proxmox | `https://host:8006/api2/json` | `PVEAPIToken=user@realm!id=secret` | nodes, node status, VM/CT list, status, start/stop/shutdown/reboot, storage, replication jobs, backup listing |
| NPM | `http(s)://host:81/api` | identity/secret → bearer token (cached until expiry) | proxy hosts, certificates, compare to expectation, enable/disable host |

Applications are data, not code: adding a fourth app is a new row with its
workloads, DNS records, NPM expectations and health checks. Nothing in the
engine knows the words "WordPress" or "Nextcloud"; seed templates exist for
those three for convenience.

## 2.6 Code layout

```
server/src
  config.ts            env parsing (zod)
  db/                  pool, migration runner, migrations/*.sql
  security/            secrets (AES-256-GCM), passwords (scrypt), redaction
  http/                guarded HTTP client
  providers/           cloudflare, proxmox, npm, tunnel (+ shared errors)
  health/              check executors, evaluator, aggregator, engine
  state/               failover + site state machines (pure) and store
  orchestrator/        readiness, failover/dry-run steps, runner, change executor
  audit/               audit writer + query
  repos/               SQL repositories
  api/                 Fastify app, auth, routes, OpenAPI
server/test
  unit/                pure logic
  integration/         Fastify + Postgres + fake Cloudflare/Proxmox/NPM servers
web/src                React app
docs/                  this design set + operator docs
```
