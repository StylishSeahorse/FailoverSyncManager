/** Per-site role state machine (spec §6). Pure. */
export const SITE_STATES = ['PRIMARY', 'SECONDARY', 'FAILED', 'PROMOTING', 'ACTIVE', 'DEGRADED', 'RECOVERY', 'MAINTENANCE'] as const;
export type SiteState = (typeof SITE_STATES)[number];

export type SiteEvent =
  | 'DEGRADE'
  | 'RECOVERED'
  | 'CONFIRMED_FAILED'
  | 'PROMOTE_START'
  | 'PROMOTED'
  | 'PROMOTE_FAILED'
  | 'HEALTH_RETURNED'
  | 'DEMOTE'
  | 'RECONCILE_SERVING'
  | 'RECONCILE_STANDBY';

/** States in which a site is serving production traffic. */
export const SERVING_STATES: readonly SiteState[] = ['PRIMARY', 'ACTIVE', 'DEGRADED'];

export interface SiteContext {
  designatedRole: 'primary' | 'secondary';
}

export class InvalidSiteTransitionError extends Error {
  constructor(
    public readonly from: SiteState,
    public readonly event: SiteEvent,
  ) {
    super(`Site transition ${event} is not allowed from ${from}`);
    this.name = 'InvalidSiteTransitionError';
  }
}

export function nextSiteState(from: SiteState, event: SiteEvent, ctx: SiteContext): SiteState {
  const servingState: SiteState = ctx.designatedRole === 'primary' ? 'PRIMARY' : 'ACTIVE';
  const t: Partial<Record<SiteState, Partial<Record<SiteEvent, SiteState>>>> = {
    PRIMARY: { DEGRADE: 'DEGRADED', CONFIRMED_FAILED: 'FAILED', RECONCILE_STANDBY: 'SECONDARY' },
    ACTIVE: { DEGRADE: 'DEGRADED', CONFIRMED_FAILED: 'FAILED', RECONCILE_STANDBY: 'SECONDARY' },
    DEGRADED: { RECOVERED: servingState, CONFIRMED_FAILED: 'FAILED', RECONCILE_STANDBY: 'SECONDARY' },
    SECONDARY: { PROMOTE_START: 'PROMOTING', RECONCILE_SERVING: servingState },
    PROMOTING: { PROMOTED: 'ACTIVE', PROMOTE_FAILED: 'SECONDARY', RECONCILE_SERVING: 'ACTIVE', RECONCILE_STANDBY: 'SECONDARY' },
    FAILED: { HEALTH_RETURNED: 'RECOVERY', RECONCILE_SERVING: servingState, RECONCILE_STANDBY: 'FAILED' },
    RECOVERY: { DEMOTE: 'SECONDARY', CONFIRMED_FAILED: 'FAILED', RECONCILE_SERVING: servingState, RECONCILE_STANDBY: 'RECOVERY' },
  };
  const to = t[from]?.[event];
  if (!to) throw new InvalidSiteTransitionError(from, event);
  return to;
}

/**
 * Split-brain guard: given the proposed states of all sites, at most one may
 * be serving.
 */
export function servingConflict(states: Array<{ code: string; state: SiteState }>): string | null {
  const serving = states.filter((s) => SERVING_STATES.includes(s.state));
  if (serving.length > 1) return `Split-brain prevented: sites ${serving.map((s) => s.code).join(' and ')} would both be serving`;
  return null;
}
