# 3. Database schema

PostgreSQL 16. The authoritative DDL is
[`server/src/db/migrations/001_init.sql`](../../server/src/db/migrations/001_init.sql);
migrations are plain SQL applied in order by `server/src/db/migrate.ts` and
recorded in `schema_migrations`.

## 3.1 Entity overview

```
users ─< sessions
secrets  (referenced by proxmox_instances, npm_instances, cloudflare_accounts)

sites ─< proxmox_instances
      ─< npm_instances
      ─  tunnels >─ cloudflare_accounts ─< cloudflare_zones
      ─  site_states

applications ─< workloads        (site, proxmox instance, node, vmid)
             ─< dns_records      (zone, discovered record_id, primary/secondary content)
             ─< npm_expectations (site, npm instance, expected proxy host)
             ─< health_checks    (application_id null ⇒ site-scoped)

health_checks ─ health_check_state (1:1, threshold evaluator memory)
              ─< health_check_results (time series, pruned)

policies (exactly one active)
controller_state (singleton row, versioned)
operations ─< operation_steps
state_transitions (every state change, both machines)
audit_events (append-only, full-text searchable)
```

## 3.2 Notable design decisions

| Decision | Why |
|---|---|
| Secrets live in their own table as AES-256-GCM ciphertext + IV + tag + key version | Credentials never appear in config rows, API responses or logs; key rotation re-encrypts one table. |
| `sessions.id_hash` stores SHA-256 of the cookie token | A DB dump cannot be replayed as a live session. |
| `cloudflare_zones.zone_id`, `dns_records.record_id`, `npm_expectations.proxy_host_id` are *discovered* | Spec §7: no hand-typed IDs. The UI only offers IDs returned by the provider. |
| `dns_records` has `CHECK (primary_content <> secondary_content)` | A record whose two targets are equal can never fail over and hides misconfiguration. |
| `workloads` requires `expected_name` and explicit `allow_start` / `allow_stop` | A VMID typo can't make FSM start the wrong VM; the name is verified before every action. |
| `health_checks.path` + `independence_group` | Confirmation counts distinct groups, not raw check count (dangerous assumption D1). |
| `policies_one_active` partial unique index | There is always at most one policy in force; Phase 2+ can add more without code changes. |
| `controller_state` singleton with `version` | Optimistic concurrency: a transition from a stale read fails instead of overwriting. |
| `audit_events` has an UPDATE/DELETE trigger that raises | Append-only by construction; retention is done by partition/drop in a later phase, never by row edits. |
| `audit_events.search` generated `tsvector` + GIN | Searchable/filterable logs without a separate search service. |
| `operations.acknowledged text[]` | The exact overridable blockers the operator accepted (e.g. `replication.nextcloud`) are recorded with the operation, not just "forced". |

## 3.3 Retention

`health_check_results` grows by `checks × 86400 / interval` rows per day
(≈ 60 checks at 15 s ≈ 350k rows/day). The engine prunes results older than
`FSM_RESULT_RETENTION_DAYS` (default 14) hourly. Audit events and operations
are kept indefinitely in Phase 1.

## 3.4 Phase 2/3 additions (planned)

* `maintenance_windows (id, starts_at, ends_at, reason, created_by)`
* `notification_channels (id, kind email|discord|webhook, config, secret_id, events[])`
* `witnesses (id, name, base_url, secret_id, last_seen_at, vote)`
* `circuit_breaker_events` (or derived from `operations`)
