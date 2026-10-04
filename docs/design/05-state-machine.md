# 5. State machines

Two machines, both implemented as pure transition tables in
`server/src/state/` and persisted through `StateStore`, which applies a
transition only if the stored version matches what was read and writes a
`state_transitions` row plus an audit event in the same transaction.

## 5.1 Failover (controller) machine

```
                 ┌───────────── RECOVERED ─────────────┐
                 ▼                                      │
HEALTHY_PRIMARY ──DEGRADE──► DEGRADED_PRIMARY ──FAILURE_SUSPECTED──► FAILURE_DETECTED
     ▲                           │                                      │
     └────────RECOVERED──────────┘                         CONFIRM_START│
                                                                         ▼
                                                              CONFIRMING_FAILURE
                                     RECOVERED / NOT_CONFIRMED ◄────────┤
                                                                         │ CONFIRMED
                                                                         ▼
                                                          PRIMARY_CONFIRMED_FAILED
   (manual "Failover Now" may also start here from HEALTHY/DEGRADED/FAILURE_DETECTED
    with the primary-still-healthy blocker acknowledged)
                                                                         │ BEGIN_FAILOVER
                                                                         ▼
                                                                  CHECK_SECONDARY
                                                                         │ SECONDARY_OK
                                                                         ▼
                                                                  SECONDARY_READY
                                                                         │ PROMOTE
                                                                         ▼
                                                               PROMOTING_SECONDARY
                                                                         │ PROMOTED
                                                                         ▼
                                                                 UPDATING_ROUTING
                                                                         │ ROUTING_UPDATED
                                                                         ▼
                                                                 VERIFYING_TRAFFIC
                                                                         │ VERIFIED
                                                                         ▼
                                                                SECONDARY_ACTIVE

any of CHECK_SECONDARY … VERIFYING_TRAFFIC ──STEP_FAILED──► FAILOVER_FAILED
CHECK_SECONDARY / SECONDARY_READY / PROMOTING_SECONDARY ──CANCEL──► (state before BEGIN_FAILOVER)
FAILOVER_FAILED ──RECONCILE(observed)──► HEALTHY_PRIMARY | SECONDARY_ACTIVE
```

Rules:

* **Cancel is only possible before routing changes.** Once `UPDATING_ROUTING`
  is entered the operation runs to `SECONDARY_ACTIVE` or `FAILOVER_FAILED`.
* **`FAILOVER_FAILED` is sticky.** No automatic transition leaves it. The
  operator runs *Reconcile*, which reads the managed DNS records from
  Cloudflare and moves the machine to the state the records prove
  (all primary → `HEALTHY_PRIMARY`; all secondary → `SECONDARY_ACTIVE`; mixed →
  stays failed and says which records point where).
* Monitoring-driven transitions (`DEGRADE`, `FAILURE_SUSPECTED`,
  `CONFIRM_START`, `CONFIRMED`, `RECOVERED`) are only applied while no
  operation is running.
* In Phase 1 automatic failover is disabled: the machine can reach
  `PRIMARY_CONFIRMED_FAILED` on its own (and says so loudly) but only a person
  issues `BEGIN_FAILOVER`.
* `SECONDARY_ACTIVE` exits only via failback (Phase 3) or Reconcile.

## 5.2 Site machine

States per spec §6: `PRIMARY, SECONDARY, FAILED, PROMOTING, ACTIVE, DEGRADED,
RECOVERY, MAINTENANCE`.

| From | Event | To |
|---|---|---|
| PRIMARY | DEGRADE | DEGRADED |
| DEGRADED | RECOVERED | PRIMARY (if designated primary and active) |
| PRIMARY / DEGRADED | CONFIRMED_FAILED | FAILED |
| SECONDARY | PROMOTE_START | PROMOTING |
| PROMOTING | PROMOTED | ACTIVE |
| PROMOTING | PROMOTE_FAILED | SECONDARY |
| ACTIVE | DEGRADE | DEGRADED |
| FAILED | HEALTH_RETURNED | RECOVERY |
| RECOVERY | DEMOTE (failback prep, Phase 3) | SECONDARY |
| any | MAINTENANCE_ON | MAINTENANCE (Phase 2) |
| MAINTENANCE | MAINTENANCE_OFF | previous state |

**Invariant (split-brain guard):** at most one site may be in `ACTIVE` or
`PRIMARY` serving state. `StateStore` checks this inside the transaction that
promotes a site; a promotion that would produce two serving sites is rejected
and audited as `CRITICAL`. `PRIMARY` means "designated primary and serving";
`ACTIVE` means "serving after a failover".

## 5.3 Health status (per check)

```
UNKNOWN ─► OK ─(fail)─► WARNING ─(≥N fails)─► DEGRADED ─(≥N fails ∧ ≥T since first)─► FAILED
            ▲              │                      │                                     │
            └─(success)────┘                      └──(M consecutive successes)──────────┘
```

A single success while WARNING returns to OK (one dropped packet is noise); a
check that reached DEGRADED or FAILED needs `recovery_consecutive_successes`
in a row, so a flapping service cannot bounce the site state.
