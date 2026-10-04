import type { AuditLog } from '../audit/audit.js';
import type { HealthCheck, Site } from '../domain/types.js';
import type { HealthStateRepo } from '../repos/healthState.js';
import type { Repos } from '../repos/index.js';
import type { PolicyRepo } from '../repos/policy.js';
import { SYSTEM_ACTOR } from '../domain/types.js';
import type { CheckView } from './aggregate.js';
import { evaluate, type EvaluatorState } from './evaluator.js';
import { runCheck } from './checks/executors.js';
import type { CheckDeps, CheckResult } from './checks/types.js';

export interface EngineOptions {
  now?: () => Date;
  /** Called after any check changes, with the affected site. Serialised by the caller. */
  onSiteEvaluated?: (siteId: string) => Promise<void>;
  /** Random start offset, as a fraction of the interval, to spread load. */
  jitter?: number;
  /**
   * Traffic checks prove users reach a site through production hostnames, so
   * they only mean something for the site currently receiving traffic.
   */
  isActiveSite?: (siteId: string) => boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  network: 'network',
  infrastructure: 'infrastructure',
  application: 'application',
  tunnel: 'tunnel',
  traffic: 'traffic',
  replication: 'replication',
};

/**
 * Schedules and executes health checks, applies thresholds, persists state and
 * reports status *changes* to the audit log in the language of an engineer
 * ("Site A HTTP check failed", not "Site A is down").
 */
export class HealthEngine {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = false;
  private paused = false;
  private sites = new Map<string, Site>();
  private inFlight = new Set<string>();

  constructor(
    private readonly repos: Repos,
    private readonly state: HealthStateRepo,
    private readonly policies: PolicyRepo,
    private readonly audit: AuditLog,
    private readonly deps: CheckDeps,
    private readonly opts: EngineOptions = {},
  ) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.reload();
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Re-reads check definitions (after configuration changes). */
  async reload(): Promise<void> {
    this.sites = new Map((await this.repos.sites.list()).map((s) => [s.id, s]));
    if (!this.running) return;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const checks = (await this.repos.healthChecks.list()).filter((c) => c.enabled);
    for (const c of checks) this.schedule(c, Math.random() * (this.opts.jitter ?? 1) * c.intervalSeconds * 1000);
  }

  private schedule(check: HealthCheck, delayMs: number) {
    const t = setTimeout(async () => {
      if (!this.running) return;
      if (!this.paused) await this.runAndRecord(check).catch(() => undefined);
      if (this.running && this.timers.has(check.id)) this.schedule(check, check.intervalSeconds * 1000);
    }, delayMs);
    t.unref?.();
    this.timers.set(check.id, t);
  }

  /** Executes a check without recording anything (ad-hoc "run now" from the UI). */
  runOnce(check: HealthCheck): Promise<CheckResult> {
    return runCheck(check, this.deps);
  }

  /** Executes, evaluates thresholds, persists and audits one check. */
  async runAndRecord(check: HealthCheck, notify = true): Promise<{ result: CheckResult; state: EvaluatorState }> {
    if (check.category === 'traffic' && this.opts.isActiveSite && !this.opts.isActiveSite(check.siteId)) {
      return { result: { ok: true, message: 'standby site: production traffic not routed here' }, state: await this.state.get(check.id) };
    }
    if (this.inFlight.has(check.id)) {
      return { result: { ok: false, message: 'check already running' }, state: await this.state.get(check.id) };
    }
    this.inFlight.add(check.id);
    try {
      const result = await runCheck(check, this.deps);
      const at = this.now();
      const policy = await this.policies.active();
      const prev = await this.state.get(check.id);
      const next = evaluate(prev, { ok: result.ok, message: result.message, latencyMs: result.latencyMs, observed: result.observed, at }, policy);
      await this.state.save(check.id, next);
      await this.state.recordResult(check.id, result.ok, result.latencyMs ?? null, result.message, result.observed ?? {}, at);
      if (prev.status !== next.status) await this.auditChange(check, prev, next);
      if (notify) await this.opts.onSiteEvaluated?.(check.siteId);
      return { result, state: next };
    } finally {
      this.inFlight.delete(check.id);
    }
  }

  /** Runs every enabled check for a site now ("Validate Site"). */
  async runSite(siteId: string, filter: (c: HealthCheck) => boolean = () => true) {
    const checks = (await this.repos.healthChecks.list({ siteId })).filter((c) => c.enabled && filter(c));
    const out = await Promise.all(checks.map(async (c) => ({ check: c, ...(await this.runAndRecord(c, false)) })));
    await this.opts.onSiteEvaluated?.(siteId);
    return out;
  }

  async views(): Promise<CheckView[]> {
    const [checks, states] = await Promise.all([this.repos.healthChecks.list(), this.state.all()]);
    return checks.map((check) => ({
      check,
      state: states.get(check.id) ?? { status: 'UNKNOWN', lastMessage: '', consecutiveFailures: 0, firstFailureAt: null, lastResultAt: null },
    }));
  }

  private async auditChange(check: HealthCheck, prev: EvaluatorState, next: EvaluatorState) {
    const site = this.sites.get(check.siteId) ?? (await this.repos.sites.get(check.siteId));
    const label = `${site?.name ?? 'Site'} ${CATEGORY_LABEL[check.category]} check "${check.name}"`;
    let severity: 'INFO' | 'WARNING' | 'ERROR' = 'WARNING';
    let message: string;
    switch (next.status) {
      case 'WARNING':
        message = `${label} failed: ${next.lastMessage}`;
        break;
      case 'DEGRADED':
        message = `${label} failing repeatedly (${next.consecutiveFailures} consecutive): ${next.lastMessage}`;
        break;
      case 'FAILED': {
        const since = next.firstFailureAt ? Math.round((this.now().getTime() - next.firstFailureAt.getTime()) / 1000) : 0;
        message = `${label} FAILED (${next.consecutiveFailures} consecutive failures over ${since}s): ${next.lastMessage}`;
        severity = 'ERROR';
        break;
      }
      case 'OK':
        message = prev.status === 'UNKNOWN' ? `${label} passing: ${next.lastMessage}` : `${label} recovered: ${next.lastMessage}`;
        severity = 'INFO';
        break;
      default:
        message = `${label} ${next.status}`;
    }
    await this.audit.write({
      severity,
      category: 'health',
      action: `check.${next.status.toLowerCase()}`,
      message,
      actor: SYSTEM_ACTOR,
      siteId: check.siteId,
      applicationId: check.applicationId,
      details: { checkId: check.id, type: check.type, path: check.path, group: check.independenceGroup, from: prev.status, to: next.status },
    });
  }
}
