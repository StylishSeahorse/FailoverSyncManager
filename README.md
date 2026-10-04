# FailoverSyncManager

A two-site high availability and disaster recovery controller for
Proxmox, Cloudflare (DNS and Tunnel) and Nginx Proxy Manager. It protects
WordPress, Invoice Ninja, Nextcloud and any other application you add.

It is built to answer one question honestly:

> **If Site A disappeared right now, can I safely move production to Site B?**

When the answer is YES, one person can move production, with every step
checked and recorded. When it is NO, the dashboard says exactly why.

## Principles

- **Data integrity first.** Replication age is measured per application. A
  failover that would lose more data than an application allows needs an
  administrator's written acknowledgement.
- **No false failovers.** A site counts as failed only when checks fail in
  several independent groups, including at least one that does not travel
  over the SD-WAN. Phase 1 never fails over on its own.
- **No split brain.** At most one site can be serving at any time; this is
  enforced in the database transaction that changes site state.
- **No silent rollback, no auto-failback.** A partial failure stops in
  `FAILOVER_FAILED`, with a list of exactly what changed. You reconcile from
  actual DNS.
- **Dry run before every real action.** Test Failover runs every step against
  live systems in read-only mode.
- **Everything audited.** Append-only, searchable event log, with secrets
  redacted.

## Phase 1 status

| Area | State |
|---|---|
| Authentication, sessions, CSRF, RBAC (viewer / operator / admin) | done |
| Encrypted credential storage (AES-256-GCM, write-only API) | done |
| Sites, applications, workloads, DNS records, NPM expectations | done |
| Health engine with thresholds, paths and independence groups | done |
| Cloudflare, Proxmox and NPM integrations | done |
| Failover state machine and site state machine with split-brain guard | done |
| Test Failover (dry run) and manual Failover Now | done |
| Cancel, Reconcile, pause and resume monitoring | done |
| Audit log with search and filters | done |
| NOC dashboard, OpenAPI docs at `/api/docs`, Docker Compose, CI | done |
| Automatic failover, maintenance mode, key rotation | Phase 2 |
| Controlled failback with data resync | Phase 3 |

## Repository layout

```
server/   Node + TypeScript + Fastify controller, PostgreSQL migrations, tests
web/      React + TypeScript + Vite dashboard
deploy/   Docker Compose, nginx TLS config, .env.example
docs/     Design documents and the operator guide
```

## Getting started

- **Deploy:** see the [operator guide](docs/operator-guide.md#deploying-with-docker-compose).
- **Try it locally with no infrastructure:** see the [demo](docs/operator-guide.md#trying-it-locally-without-infrastructure).
- **Understand the design:** see [docs/README.md](docs/README.md).

## Development

Requires Node 22 and PostgreSQL 16.

```sh
npm ci
export DATABASE_URL=postgres://failover:failover@localhost:5432/failover_test
npm run lint && npm run typecheck && npm test && npm run build
```

The tests never contact real Cloudflare, Proxmox or NPM. They run against fake
servers on 127.0.0.1 that model those APIs, including fault injection. A guard
in `server/test/setup.ts` fails the run if anything tries to connect to any
other host.
