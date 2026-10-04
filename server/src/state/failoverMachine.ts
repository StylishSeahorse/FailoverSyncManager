/**
 * Controller failover state machine (docs/design/05-state-machine.md). Pure:
 * no I/O, so the full transition table is unit tested.
 */
export const FAILOVER_STATES = [
  'HEALTHY_PRIMARY',
  'DEGRADED_PRIMARY',
  'FAILURE_DETECTED',
  'CONFIRMING_FAILURE',
  'PRIMARY_CONFIRMED_FAILED',
  'CHECK_SECONDARY',
  'SECONDARY_READY',
  'PROMOTING_SECONDARY',
  'UPDATING_ROUTING',
  'VERIFYING_TRAFFIC',
  'SECONDARY_ACTIVE',
  'FAILOVER_FAILED',
] as const;
export type FailoverState = (typeof FAILOVER_STATES)[number];

export type FailoverEvent =
  | 'DEGRADE'
  | 'FAILURE_SUSPECTED'
  | 'CONFIRM_START'
  | 'CONFIRMED'
  | 'NOT_CONFIRMED'
  | 'RECOVERED'
  | 'BEGIN_FAILOVER'
  | 'SECONDARY_OK'
  | 'PROMOTE'
  | 'PROMOTED'
  | 'ROUTING_UPDATED'
  | 'VERIFIED'
  | 'STEP_FAILED'
  | 'CANCEL'
  | 'RECONCILE_PRIMARY'
  | 'RECONCILE_SECONDARY';

/** States the monitoring loop may move between while the primary is serving. */
export const MONITORING_STATES: readonly FailoverState[] = [
  'HEALTHY_PRIMARY',
  'DEGRADED_PRIMARY',
  'FAILURE_DETECTED',
  'CONFIRMING_FAILURE',
  'PRIMARY_CONFIRMED_FAILED',
];

/** States in which a failover operation is in flight. */
export const IN_FLIGHT_STATES: readonly FailoverState[] = [
  'CHECK_SECONDARY',
  'SECONDARY_READY',
  'PROMOTING_SECONDARY',
  'UPDATING_ROUTING',
  'VERIFYING_TRAFFIC',
];

/** Before routing changes, an operation may still be cancelled. */
export const CANCELLABLE_STATES: readonly FailoverState[] = ['CHECK_SECONDARY', 'SECONDARY_READY', 'PROMOTING_SECONDARY'];

type Table = Partial<Record<FailoverState, Partial<Record<FailoverEvent, FailoverState>>>>;

const TABLE: Table = {
  HEALTHY_PRIMARY: {
    DEGRADE: 'DEGRADED_PRIMARY',
    FAILURE_SUSPECTED: 'FAILURE_DETECTED',
    BEGIN_FAILOVER: 'CHECK_SECONDARY',
    RECONCILE_SECONDARY: 'SECONDARY_ACTIVE',
  },
  DEGRADED_PRIMARY: {
    RECONCILE_SECONDARY: 'SECONDARY_ACTIVE',
    RECOVERED: 'HEALTHY_PRIMARY',
    FAILURE_SUSPECTED: 'FAILURE_DETECTED',
    BEGIN_FAILOVER: 'CHECK_SECONDARY',
  },
  FAILURE_DETECTED: {
    RECONCILE_SECONDARY: 'SECONDARY_ACTIVE',
    RECOVERED: 'HEALTHY_PRIMARY',
    DEGRADE: 'DEGRADED_PRIMARY',
    CONFIRM_START: 'CONFIRMING_FAILURE',
    BEGIN_FAILOVER: 'CHECK_SECONDARY',
  },
  CONFIRMING_FAILURE: {
    RECONCILE_SECONDARY: 'SECONDARY_ACTIVE',
    CONFIRMED: 'PRIMARY_CONFIRMED_FAILED',
    NOT_CONFIRMED: 'FAILURE_DETECTED',
    RECOVERED: 'HEALTHY_PRIMARY',
    DEGRADE: 'DEGRADED_PRIMARY',
    BEGIN_FAILOVER: 'CHECK_SECONDARY',
  },
  PRIMARY_CONFIRMED_FAILED: {
    RECONCILE_SECONDARY: 'SECONDARY_ACTIVE',
    BEGIN_FAILOVER: 'CHECK_SECONDARY',
    RECOVERED: 'HEALTHY_PRIMARY',
    NOT_CONFIRMED: 'FAILURE_DETECTED',
  },
  CHECK_SECONDARY: { SECONDARY_OK: 'SECONDARY_READY', STEP_FAILED: 'FAILOVER_FAILED' },
  SECONDARY_READY: { PROMOTE: 'PROMOTING_SECONDARY', STEP_FAILED: 'FAILOVER_FAILED' },
  PROMOTING_SECONDARY: { PROMOTED: 'UPDATING_ROUTING', STEP_FAILED: 'FAILOVER_FAILED' },
  UPDATING_ROUTING: { ROUTING_UPDATED: 'VERIFYING_TRAFFIC', STEP_FAILED: 'FAILOVER_FAILED' },
  VERIFYING_TRAFFIC: { VERIFIED: 'SECONDARY_ACTIVE', STEP_FAILED: 'FAILOVER_FAILED' },
  SECONDARY_ACTIVE: { RECONCILE_PRIMARY: 'HEALTHY_PRIMARY' },
  FAILOVER_FAILED: { RECONCILE_PRIMARY: 'HEALTHY_PRIMARY', RECONCILE_SECONDARY: 'SECONDARY_ACTIVE' },
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: FailoverState,
    public readonly event: FailoverEvent,
  ) {
    super(`Transition ${event} is not allowed from ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * CANCEL returns to the monitoring state the operation started from, so it is
 * resolved by the caller (which knows that state); the table only says whether
 * cancelling is allowed.
 */
export function nextFailoverState(from: FailoverState, event: FailoverEvent, cancelTo?: FailoverState): FailoverState {
  if (event === 'CANCEL') {
    if (!CANCELLABLE_STATES.includes(from)) throw new InvalidTransitionError(from, event);
    if (!cancelTo || !MONITORING_STATES.includes(cancelTo)) throw new InvalidTransitionError(from, event);
    return cancelTo;
  }
  const to = TABLE[from]?.[event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTransition(from: FailoverState, event: FailoverEvent): boolean {
  if (event === 'CANCEL') return CANCELLABLE_STATES.includes(from);
  return Boolean(TABLE[from]?.[event]);
}

/** The monitoring-level target state for a primary that is still serving. */
export type MonitorTarget = 'HEALTHY_PRIMARY' | 'DEGRADED_PRIMARY' | 'FAILURE_DETECTED' | 'CONFIRMING_FAILURE' | 'PRIMARY_CONFIRMED_FAILED';

const MONITOR_EVENTS: FailoverEvent[] = ['RECOVERED', 'DEGRADE', 'FAILURE_SUSPECTED', 'CONFIRM_START', 'CONFIRMED', 'NOT_CONFIRMED'];

/**
 * Shortest path of monitoring events from one monitoring state to another, so
 * the machine never jumps: every intermediate state is entered and logged
 * (e.g. HEALTHY → FAILURE_DETECTED → CONFIRMING_FAILURE → PRIMARY_CONFIRMED_FAILED).
 */
export function monitoringPath(from: FailoverState, to: MonitorTarget): FailoverEvent[] {
  if (!MONITORING_STATES.includes(from) || from === to) return [];
  const queue: Array<{ state: FailoverState; path: FailoverEvent[] }> = [{ state: from, path: [] }];
  const seen = new Set<FailoverState>([from]);
  while (queue.length) {
    const { state, path } = queue.shift()!;
    for (const ev of MONITOR_EVENTS) {
      const next = TABLE[state]?.[ev];
      if (!next || seen.has(next)) continue;
      if (next === to) return [...path, ev];
      seen.add(next);
      queue.push({ state: next, path: [...path, ev] });
    }
  }
  return [];
}
