import { describe, expect, it } from 'vitest';
import {
  canTransition,
  FAILOVER_STATES,
  InvalidTransitionError,
  monitoringPath,
  nextFailoverState,
  type FailoverEvent,
  type FailoverState,
} from '../../src/state/failoverMachine.js';
import { nextSiteState, servingConflict } from '../../src/state/siteMachine.js';

describe('failover state machine', () => {
  it('walks the full happy path', () => {
    const path: Array<[FailoverEvent, FailoverState]> = [
      ['FAILURE_SUSPECTED', 'FAILURE_DETECTED'],
      ['CONFIRM_START', 'CONFIRMING_FAILURE'],
      ['CONFIRMED', 'PRIMARY_CONFIRMED_FAILED'],
      ['BEGIN_FAILOVER', 'CHECK_SECONDARY'],
      ['SECONDARY_OK', 'SECONDARY_READY'],
      ['PROMOTE', 'PROMOTING_SECONDARY'],
      ['PROMOTED', 'UPDATING_ROUTING'],
      ['ROUTING_UPDATED', 'VERIFYING_TRAFFIC'],
      ['VERIFIED', 'SECONDARY_ACTIVE'],
    ];
    let s: FailoverState = 'HEALTHY_PRIMARY';
    for (const [ev, to] of path) {
      s = nextFailoverState(s, ev);
      expect(s).toBe(to);
    }
  });

  it('every in-flight state can fail into FAILOVER_FAILED', () => {
    for (const s of ['CHECK_SECONDARY', 'SECONDARY_READY', 'PROMOTING_SECONDARY', 'UPDATING_ROUTING', 'VERIFYING_TRAFFIC'] as const) {
      expect(nextFailoverState(s, 'STEP_FAILED')).toBe('FAILOVER_FAILED');
    }
  });

  it('FAILOVER_FAILED is sticky: only reconcile leaves it', () => {
    const allowed = (['RECOVERED', 'BEGIN_FAILOVER', 'DEGRADE', 'VERIFIED', 'CANCEL', 'RECONCILE_PRIMARY', 'RECONCILE_SECONDARY'] as FailoverEvent[]).filter((e) =>
      canTransition('FAILOVER_FAILED', e),
    );
    expect(allowed).toEqual(['RECONCILE_PRIMARY', 'RECONCILE_SECONDARY']);
  });

  it('cannot begin a failover while one is in flight or after one succeeded', () => {
    for (const s of ['CHECK_SECONDARY', 'UPDATING_ROUTING', 'SECONDARY_ACTIVE', 'FAILOVER_FAILED'] as const) {
      expect(() => nextFailoverState(s, 'BEGIN_FAILOVER')).toThrow(InvalidTransitionError);
    }
  });

  it('cancels only before routing changes and returns to the starting state', () => {
    expect(nextFailoverState('PROMOTING_SECONDARY', 'CANCEL', 'PRIMARY_CONFIRMED_FAILED')).toBe('PRIMARY_CONFIRMED_FAILED');
    expect(() => nextFailoverState('UPDATING_ROUTING', 'CANCEL', 'HEALTHY_PRIMARY')).toThrow();
    expect(() => nextFailoverState('VERIFYING_TRAFFIC', 'CANCEL', 'HEALTHY_PRIMARY')).toThrow();
    expect(() => nextFailoverState('CHECK_SECONDARY', 'CANCEL', 'SECONDARY_ACTIVE')).toThrow();
  });

  it('monitoring transitions never apply to in-flight states', () => {
    for (const s of ['CHECK_SECONDARY', 'PROMOTING_SECONDARY', 'UPDATING_ROUTING', 'SECONDARY_ACTIVE', 'FAILOVER_FAILED'] as const) {
      expect(monitoringPath(s, 'HEALTHY_PRIMARY')).toEqual([]);
    }
  });

  it('monitoring path enters every intermediate state', () => {
    expect(monitoringPath('HEALTHY_PRIMARY', 'PRIMARY_CONFIRMED_FAILED')).toEqual(['FAILURE_SUSPECTED', 'CONFIRM_START', 'CONFIRMED']);
    expect(monitoringPath('DEGRADED_PRIMARY', 'CONFIRMING_FAILURE')).toEqual(['FAILURE_SUSPECTED', 'CONFIRM_START']);
    expect(monitoringPath('PRIMARY_CONFIRMED_FAILED', 'HEALTHY_PRIMARY')).toEqual(['RECOVERED']);
    expect(monitoringPath('PRIMARY_CONFIRMED_FAILED', 'FAILURE_DETECTED')).toEqual(['NOT_CONFIRMED']);
    expect(monitoringPath('CONFIRMING_FAILURE', 'DEGRADED_PRIMARY')).toEqual(['DEGRADE']);
    expect(monitoringPath('HEALTHY_PRIMARY', 'HEALTHY_PRIMARY')).toEqual([]);
  });

  it('every monitoring path is made of legal transitions', () => {
    const mon = ['HEALTHY_PRIMARY', 'DEGRADED_PRIMARY', 'FAILURE_DETECTED', 'CONFIRMING_FAILURE', 'PRIMARY_CONFIRMED_FAILED'] as const;
    for (const from of mon) {
      for (const to of mon) {
        let s: FailoverState = from;
        for (const ev of monitoringPath(from, to)) s = nextFailoverState(s, ev);
        expect(s).toBe(to);
      }
    }
  });

  it('defines no transition out of an unknown event', () => {
    for (const s of FAILOVER_STATES) expect(canTransition(s, 'NOPE' as FailoverEvent)).toBe(false);
  });
});

describe('site state machine', () => {
  it('promotes a secondary to ACTIVE', () => {
    expect(nextSiteState(nextSiteState('SECONDARY', 'PROMOTE_START', { designatedRole: 'secondary' }), 'PROMOTED', { designatedRole: 'secondary' })).toBe('ACTIVE');
  });
  it('returns a degraded primary to PRIMARY and a degraded secondary to ACTIVE', () => {
    expect(nextSiteState('DEGRADED', 'RECOVERED', { designatedRole: 'primary' })).toBe('PRIMARY');
    expect(nextSiteState('DEGRADED', 'RECOVERED', { designatedRole: 'secondary' })).toBe('ACTIVE');
  });
  it('a failed site goes to RECOVERY, never straight back to serving', () => {
    expect(nextSiteState('FAILED', 'HEALTH_RETURNED', { designatedRole: 'primary' })).toBe('RECOVERY');
    expect(() => nextSiteState('FAILED', 'RECOVERED', { designatedRole: 'primary' })).toThrow();
  });
  it('detects two serving sites', () => {
    expect(servingConflict([{ code: 'A', state: 'PRIMARY' }, { code: 'B', state: 'ACTIVE' }])).toMatch(/Split-brain/);
    expect(servingConflict([{ code: 'A', state: 'FAILED' }, { code: 'B', state: 'ACTIVE' }])).toBeNull();
  });
});
