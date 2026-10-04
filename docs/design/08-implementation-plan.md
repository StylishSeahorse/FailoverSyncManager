# 8. Implementation plan

Each component is built, tested and documented before moving on (spec §33).
"Test" always includes failure paths, not only the happy path.

## Phase 1 (this branch)

| # | Component | Tests |
|---|---|---|
| 1 | Repo scaffold: npm workspaces (`server`, `web`), TypeScript strict, ESLint, Vitest, CI with Postgres service | CI runs lint, typecheck, tests, build |
| 2 | Config + guarded HTTP client (timeouts, TLS options, egress allow-list, redaction) | blocks non-allow-listed hosts, timeouts, redaction |
| 3 | DB pool, migration runner, schema | migrations apply cleanly to an empty schema; audit log immutability |
| 4 | Security primitives: secrets encryption, password hashing, redaction | round-trip, tamper detection, wrong key, no plaintext leakage |
| 5 | Audit writer + query (search, filters, pagination) | integration against Postgres |
| 6 | Providers: Cloudflare, Tunnel, Proxmox, NPM | integration against fake HTTP servers, including 401/403/429/5xx, timeouts, malformed JSON |
| 7 | Health checks (icmp, tcp, http, dns, proxmox_*, tunnel, npm_*, replication) + threshold evaluator + aggregator | evaluator truth table, false-positive scenarios (single drop, brief outage, restart), independence-group confirmation, SD-WAN-only outage |
| 8 | State machines + StateStore | exhaustive transition table tests, optimistic concurrency, single-serving-site invariant |
| 9 | Readiness service | SAFE/WARNING/UNSAFE replication, NPM mismatch, tunnel ingress missing, explainable reasons |
| 10 | Orchestrator: dry run + manual failover + cancel + reconcile | end-to-end against fakes: success; Site B Proxmox failure during promotion; Cloudflare failure mid-DNS; NPM failure; stale replication blocked/forced; out-of-band DNS edit refused; split-brain guard; simultaneous site failure; cancel before/after routing |
| 11 | API: auth (sessions, CSRF, rate limit, RBAC), config CRUD, discovery, status, operations, events, OpenAPI | route-level tests with real DB |
| 12 | Health engine scheduler wired to state machine (monitoring transitions) | integration with fakes: primary fails → PRIMARY_CONFIRMED_FAILED, recovers → HEALTHY_PRIMARY, no auto failover |
| 13 | Web UI: login, NOC dashboard (readiness YES/NO with reasons), controls with confirmation, operations view, event log, configuration screens | typecheck + build; component tests for the readiness panel and confirmation dialog |
| 14 | Docker Compose (nginx + server + postgres), operator docs | `docker compose config` validation |

## Phase 2

Automatic failover (engine issues `BEGIN_FAILOVER` when policy allows),
circuit breaker (`FAILOVER CIRCUIT OPEN` after N failovers in window),
maintenance mode + windows, notifications (email, Discord, webhook) behind a
`NotificationProvider` interface, replication staleness alerts, key rotation
command.

## Phase 3

Failback (Prepare/Execute with data-sync gate), external witness + quorum
voting, optional fencing of the failed site, Prometheus `/metrics`
(time-to-detect, time-to-promote, DNS change duration, failover counts,
replication age), reporting, scheduled DR tests (scheduled dry runs).

## Testing strategy

* **Unit**: pure logic (evaluator, state machines, readiness rules, redaction).
* **Integration**: Fastify app + real PostgreSQL (a fresh schema per test file)
  + fake Cloudflare/Proxmox/NPM/application HTTP servers bound to 127.0.0.1.
  The fakes are stateful and support fault injection (status codes, latency,
  drop connections, flip VM state), so scenarios such as "Cloudflare fails
  after the second DNS record" are deterministic.
* **Safety net**: the egress allow-list is set to loopback in the test setup;
  any accidental real API call fails the test immediately.
