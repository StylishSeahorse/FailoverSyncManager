# 4. REST API specification

All endpoints are under `/api`, JSON in/out. Request and response schemas are
declared with TypeBox on each route and published as **OpenAPI 3** at
`/api/openapi.json` (Swagger UI at `/api/docs`, admin only in production).

Conventions:

* Auth: session cookie `fsm_session`. State-changing requests (`POST`, `PUT`,
  `PATCH`, `DELETE`) also need header `X-CSRF-Token`.
* Roles: **V** viewer, **O** operator, **A** admin (higher roles include lower).
* Errors: `{ "error": "code", "message": "human readable", "details"?: {...} }`
  with 400 validation, 401 unauthenticated, 403 forbidden/CSRF, 404, 409
  conflict (state machine / lock), 422 precondition failed (blockers), 429.
* Secrets are write-only: request field `apiToken`, response field
  `apiTokenConfigured: boolean`.

## 4.1 Auth & users

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/auth/login` | – | `{username,password}` → sets cookie, returns user + csrfToken |
| POST | `/api/auth/logout` | V | Ends session |
| GET | `/api/auth/me` | V | Current user, role, csrfToken |
| GET/POST | `/api/users` | A | List / create users |
| PATCH/DELETE | `/api/users/:id` | A | Update role/password/disabled, delete |

## 4.2 Status (dashboard)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/system/status` | V | Everything the dashboard needs in one call: controller state, active site, per-site health dimensions, provider health, per-app status + replication age, readiness verdict + reasons, running operation |
| GET | `/api/failover/status` | V | Controller state machine, current operation, readiness |
| GET | `/api/failover/readiness?target=:siteId` | V | "Can I safely move production to Site B right now?" verdict + itemised reasons |

## 4.3 Sites & providers

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/sites` | V | Sites with state |
| POST/PATCH/DELETE | `/api/sites[/:id]` | A | Configure sites |
| GET | `/api/sites/:id/health` | V | Site, tunnel, application dimensions with per-check status and reasons |
| POST | `/api/sites/:id/validate` | O | Run all checks for the site now |
| GET/POST/PATCH/DELETE | `/api/proxmox-instances[/:id]` | V/A | Proxmox endpoints (token secret write-only) |
| POST | `/api/proxmox-instances/:id/validate` | O | Auth + node status |
| GET | `/api/proxmox-instances/:id/discover` | A | Nodes and VMs/CTs for workload registration |
| GET/POST/PATCH/DELETE | `/api/npm-instances[/:id]` | V/A | NPM endpoints |
| POST | `/api/npm-instances/:id/validate` | O | Auth + compare all expectations |
| GET | `/api/npm-instances/:id/discover` | A | Proxy hosts + certificates |
| GET/POST/PATCH/DELETE | `/api/cloudflare-accounts[/:id]` | V/A | Cloudflare accounts (token write-only) |
| POST | `/api/cloudflare-accounts/:id/validate` | O | Token verify + zone access |
| POST | `/api/cloudflare-accounts/:id/discover-zones` | A | Discover and store zones |
| GET | `/api/cloudflare-zones/:id/records` | A | Live DNS records for selection |
| GET/POST/DELETE | `/api/tunnels[/:id]` | V/A | Map a Cloudflare tunnel to a site |

## 4.4 Applications

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/applications` | V | Apps with active site, health per site, replication age |
| POST/PATCH/DELETE | `/api/applications[/:id]` | A | Configure apps |
| GET | `/api/applications/:id/health` | V | Per-site app checks, replication, NPM, DNS state |
| GET/POST/PATCH/DELETE | `/api/applications/:id/workloads[/:wid]` | V/A | Protected VMs |
| GET/POST/PATCH/DELETE | `/api/applications/:id/dns-records[/:rid]` | V/A | Managed records (record must be selected from discovery) |
| GET/POST/PATCH/DELETE | `/api/applications/:id/npm-expectations[/:eid]` | V/A | Expected NPM proxy hosts |

## 4.5 Health checks & policy

| Method | Path | Role | Description |
|---|---|---|---|
| GET/POST/PATCH/DELETE | `/api/health-checks[/:id]` | V/A | Check definitions |
| POST | `/api/health-checks/:id/run` | O | Execute once, return result (not counted toward thresholds) |
| GET | `/api/health-checks/:id/results` | V | Recent results |
| GET | `/api/policies/active` | V | Active policy |
| PUT | `/api/policies/active` | A | Update thresholds |

## 4.6 Failover operations

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/failover/prepare` | O | Live readiness evaluation for the target; returns blockers, overridable keys, the confirmation phrase, estimated data loss |
| POST | `/api/failover/test` | O | Start a dry run; returns operation id (poll `/api/operations/:id`) |
| POST | `/api/failover/execute` | O (A to acknowledge) | `{targetSiteId, confirm:"FAILOVER TO SITE B", acknowledge?: string[], reason?: string}` → 202 operation id; 422 if unacknowledged blockers; 409 if another op/state conflict |
| POST | `/api/failover/cancel` | O | Cancel the running failover before routing changes; 409 after |
| POST | `/api/failover/reconcile` | O | After FAILOVER_FAILED: read actual DNS, set state accordingly |
| POST | `/api/monitoring/pause` / `resume` | O | Pause/resume the health engine (audited) |
| GET | `/api/operations` | V | Recent operations |
| GET | `/api/operations/:id` | V | Operation with steps |
| POST | `/api/failback/prepare` / `execute` | O | **Phase 3** (501 in Phase 1) |
| POST | `/api/maintenance/enable` / `disable` | O | **Phase 2** (501 in Phase 1) |

## 4.7 Events

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/events?q=&severity=&category=&siteId=&applicationId=&operationId=&from=&to=&before=&limit=` | V | Searchable, filterable audit log; keyset pagination via `before` (id) |

## 4.8 Health of FSM itself

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/healthz` | – | Liveness (process up) |
| GET | `/readyz` | – | DB reachable + migrations applied |
| GET | `/metrics` | – | **Phase 3** Prometheus |
