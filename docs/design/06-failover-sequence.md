# 6. Failover sequence

Implemented in `server/src/orchestrator/failover.ts` as an ordered list of
steps. Each step returns `PASS | WARNING | FAIL | SKIPPED | PLANNED` with a
human-readable message and structured details, is persisted as an
`operation_steps` row and emitted as an audit event. The runner stops at the
first `FAIL` of a critical step and puts the controller into `FAILOVER_FAILED`
with `failed_stage` set to that step's key.

The same step list drives **Test Failover (dry run)**. In dry-run mode, the
`ChangeExecutor` is in plan mode: mutating steps report `PLANNED` with the
exact change they would make, and the controller state machine is not touched.

| # | Key | Spec step | Live failover | Dry run | State on entry |
|---|---|---|---|---|---|
| 0 | `lock` | – | Acquire advisory lock, check no running op, check controller state allows failover | same (shared lock, does not block monitoring) | – |
| 1 | `assess_primary` | 1–2 | Fresh run of every enabled check for the source site. Primary must be *confirmed failed* (≥ K independent groups failed per policy); otherwise blocker `primary.reachable` (overridable: planned switchover) | same, reported as info | CONFIRMING_FAILURE |
| 2 | `check_secondary` | 3 | Target Proxmox API reachable, node(s) online, CPU/RAM/storage within limits, site checks healthy ≥ policy minimum | same | CHECK_SECONDARY |
| 3 | `check_workloads` | 3 | Every secondary workload exists, name matches `expected_name`, status matches standby expectation, start permitted if needed | same | CHECK_SECONDARY |
| 4 | `check_replication` | 4 | Per app: replication age vs limit → SAFE/WARNING/UNSAFE. UNSAFE ⇒ blocker `replication.<slug>` (overridable) | same | CHECK_SECONDARY |
| 5 | `check_blockers` | – | All non-overridable blockers absent; every overridable blocker present is in `acknowledged` | report only | SECONDARY_READY |
| 6 | `promote_workloads` | 5 | Start stopped secondary workloads in `start_order`, wait for `running` | PLANNED "would start VM 220 on pve-b" | PROMOTING_SECONDARY |
| 7 | `wait_services` | 6 | Poll target-site application checks until all critical ones pass or `service_wait_timeout` | runs checks once; stopped VMs ⇒ WARNING | PROMOTING_SECONDARY |
| 8 | `validate_npm` | 7 | Target NPM reachable; each expectation matches (domains, upstream, enabled, cert valid > 7 days). Disabled host + `allow_auto_enable` ⇒ enable (audited) | same; auto-enable is PLANNED | PROMOTING_SECONDARY |
| 9 | `validate_tunnel` | 8 | Target tunnel `healthy` with ≥ 1 connection; ingress contains every hostname to move | same | PROMOTING_SECONDARY |
| 10 | `update_dns` | 9 | For each record (priority order): fetch by ID; content == primary ⇒ PATCH to secondary; == secondary ⇒ skip; anything else ⇒ FAIL (out-of-band edit). Re-read to verify. | validate token + record ownership, PLANNED per record | UPDATING_ROUTING |
| 11 | `wait_propagation` | 10 | Wait `propagation_wait_seconds`; for unproxied records also resolve via public resolvers until content matches | SKIPPED | UPDATING_ROUTING |
| 12 | `verify_traffic` | 11–12 | Public HTTPS checks on production hostnames until pass or `verify_timeout`; site marker must identify the target site | runs against validation hostnames | VERIFYING_TRAFFIC |
| 13 | `mark_active` | 13 | Apps `active_site_id = target`; target site `ACTIVE`, source `FAILED`; controller `SECONDARY_ACTIVE` | SKIPPED | SECONDARY_ACTIVE |
| 14 | `notify` | 14 | Notifier fan-out (Phase 1: audit + log notifier) | SKIPPED | – |

Dry-run verdict: `READY FOR FAILOVER` (no FAIL, no unacknowledged blocker),
`READY WITH WARNINGS`, or `NOT READY`.

## 6.1 Failure handling

* A FAIL before step 10 leaves routing untouched. Started secondary VMs are
  **left running** (stopping them is a change too, and an operator may want to
  inspect them); the report lists them.
* A FAIL during step 10 records exactly which records were changed, which
  failed and which were not attempted. No automatic rollback.
* A FAIL in steps 11–12 means DNS points at the target but traffic is not
  verified: `FAILOVER_FAILED` with "routing changed, verification failed".
* Every failure path writes an `ERROR`/`CRITICAL` audit event naming the stage.

## 6.2 Cancellation

`POST /api/failover/cancel` sets `cancel_requested`. The runner checks it
between steps and before each workload start. After step 10 begins the request
is refused (409) and audited.

## 6.3 What "explainable" looks like

The event log for a real failover reads like the spec §34 narrative because the
messages are produced by the checks and steps themselves:

```
WARNING   Site A HTTP check "WordPress public" failed: timeout after 5000 ms
WARNING   Site A HTTP + TCP checks failed (2 independent groups)
CRITICAL  Site A failure confirmed: 3 independent groups failed (http, tcp, proxmox), Tunnel A down per Cloudflare
INFO      Site B Proxmox healthy (node pve-b online, CPU 12%, RAM 41%)
INFO      Secondary replication age: wordpress 7 min, invoiceninja 7 min, nextcloud 9 min (all within limits)
INFO      Site B is safe to promote
INFO      Started VM 220 (wordpress-b) on pve-b
SUCCESS   Cloudflare DNS updated: app.example.com CNAME tunnelA → tunnelB
SUCCESS   External HTTPS validation successful (served by site-b)
SUCCESS   Site B ACTIVE
```
