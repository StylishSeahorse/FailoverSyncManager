import type { AuditLog } from '../audit/audit.js';
import { SYSTEM_ACTOR, type Site } from '../domain/types.js';
import type { PolicyRepo } from '../repos/policy.js';
import type { Repos } from '../repos/index.js';
import { MONITORING_STATES, monitoringPath, type MonitorTarget } from '../state/failoverMachine.js';
import type { StateStore } from '../state/store.js';
import type { SiteEvent } from '../state/siteMachine.js';
import { confirmSiteFailure, siteHealth, type Confirmation, type MonitorLevel } from './aggregate.js';
import type { HealthEngine } from './engine.js';

const TARGET: Record<MonitorLevel, MonitorTarget> = {
  HEALTHY: 'HEALTHY_PRIMARY',
  DEGRADED: 'DEGRADED_PRIMARY',
  FAILURE_DETECTED: 'FAILURE_DETECTED',
  CONFIRMING: 'CONFIRMING_FAILURE',
  CONFIRMED: 'PRIMARY_CONFIRMED_FAILED',
};

/**
 * Turns aggregated health into state-machine transitions. Never starts a
 * failover: in Phase 1 the furthest it goes on its own is
 * PRIMARY_CONFIRMED_FAILED, and it says why.
 */
export class Monitor {
  private chain: Promise<void> = Promise.resolve();
  lastConfirmation: Confirmation | null = null;

  constructor(
    private readonly repos: Repos,
    private readonly policies: PolicyRepo,
    private readonly store: StateStore,
    private readonly audit: AuditLog,
    private readonly engine: () => HealthEngine,
  ) {}

  /** Serialised evaluation; safe to call from every check completion. */
  evaluate(): Promise<void> {
    this.chain = this.chain.then(() => this.evaluateNow()).catch(() => undefined);
    return this.chain;
  }

  private async evaluateNow(): Promise<void> {
    const ctl = await this.store.controller();
    const sites = await this.repos.sites.list();
    const states = await this.store.siteStates();
    const views = await this.engine().views();
    const policy = await this.policies.active();
    const active = sites.find((s) => s.id === ctl.activeSiteId);

    if (active && !ctl.currentOperationId) {
      const conf = confirmSiteFailure(active.name, active.id, views, policy);
      this.lastConfirmation = conf;
      if (MONITORING_STATES.includes(ctl.failoverState)) {
        const target = TARGET[conf.level];
        for (const ev of monitoringPath(ctl.failoverState, target)) {
          const applied = await this.store.transitionFailover(ev, {
            actor: SYSTEM_ACTOR,
            reason: conf.reasons.join('; ') || `${active.name} checks healthy`,
            onlyFrom: MONITORING_STATES,
            set: {},
          });
          if (!applied) break; // an operation started meanwhile
        }
      }
      await this.updateActiveSite(active, conf, states.get(active.id)?.state);
    }

    // Non-active sites that were failed and are healthy again move to RECOVERY (failback becomes possible in Phase 3).
    for (const s of sites) {
      if (s.id === ctl.activeSiteId) continue;
      if (states.get(s.id)?.state !== 'FAILED') continue;
      const h = siteHealth(s.id, views);
      if (h.site.status === 'HEALTHY') {
        await this.safeSite(s, 'HEALTH_RETURNED', `${s.name} site checks healthy again; data sync required before failback`);
      }
    }
  }

  private async updateActiveSite(site: Site, conf: Confirmation, state: string | undefined) {
    if (!state) return;
    if (conf.level === 'CONFIRMED' && ['PRIMARY', 'ACTIVE', 'DEGRADED'].includes(state)) {
      await this.safeSite(site, 'CONFIRMED_FAILED', conf.reasons.join('; '));
    } else if (['DEGRADED', 'FAILURE_DETECTED', 'CONFIRMING'].includes(conf.level) && (state === 'PRIMARY' || state === 'ACTIVE')) {
      await this.safeSite(site, 'DEGRADE', conf.reasons.join('; ') || 'checks failing');
    } else if (conf.level === 'HEALTHY' && state === 'DEGRADED') {
      await this.safeSite(site, 'RECOVERED', 'all checks healthy');
    } else if (conf.level === 'HEALTHY' && (state === 'FAILED' || state === 'RECOVERY')) {
      await this.safeSite(site, 'RECONCILE_SERVING', 'recovered before any failover; still the active site');
    }
  }

  private async safeSite(site: Site, event: SiteEvent, reason: string) {
    try {
      await this.store.transitionSites([{ site, event, reason }], { actor: SYSTEM_ACTOR });
    } catch (err) {
      await this.audit.write({
        severity: 'ERROR',
        category: 'system',
        action: 'monitor.site_transition_failed',
        message: `Could not apply ${event} to ${site.name}: ${(err as Error).message}`,
        actor: SYSTEM_ACTOR,
        siteId: site.id,
      });
    }
  }
}
