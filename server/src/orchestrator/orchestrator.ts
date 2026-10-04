import type { AuditLog } from '../audit/audit.js';
import type { Db, DbClient } from '../db/pool.js';
import type { Actor, Operation, Site, StepStatus } from '../domain/types.js';
import type { HealthEngine } from '../health/engine.js';
import type { CheckDeps } from '../health/checks/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Repos } from '../repos/index.js';
import type { OperationsRepo } from '../repos/operations.js';
import type { PolicyRepo } from '../repos/policy.js';
import { CANCELLABLE_STATES, MONITORING_STATES, type FailoverEvent, type FailoverState } from '../state/failoverMachine.js';
import type { StateStore } from '../state/store.js';
import { ChangeExecutor } from './changes.js';
import { confirmationPhrase, loadPlan, type FailoverPlan } from './plan.js';
import type { ReplicationService } from './replication.js';
import { STEPS, VALIDATION_STEPS, withKey, type Blocker, type StepContext, type StepDef, type StepOutcome } from './steps.js';

export class OperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationConflictError';
  }
}

export class PreconditionError extends Error {
  constructor(
    message: string,
    public readonly blockers: Blocker[],
  ) {
    super(message);
    this.name = 'PreconditionError';
  }
}

export interface StepReport {
  seq: number;
  key: string;
  name: string;
  status: StepStatus;
  message: string;
  details: Record<string, unknown>;
}

export interface PreflightReport {
  sourceSiteId: string;
  targetSiteId: string;
  verdict: 'READY FOR FAILOVER' | 'READY WITH WARNINGS' | 'NOT READY';
  steps: StepReport[];
  blockers: Blocker[];
  overridable: string[];
  estimatedMaxDataLossSeconds: number | null;
  confirmationPhrase: string;
}

export interface OrchestratorOptions {
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Advisory lock (key, schema) so one controller per schema runs at a time.
const OP_LOCK_KEY = 7_340_002;

interface Hooks {
  onStep?: (r: StepReport) => Promise<void>;
}

/**
 * Runs dry runs and manual failovers through the same step list. See
 * docs/design/06-failover-sequence.md.
 */
export class FailoverOrchestrator {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly repos: Repos,
    private readonly policies: PolicyRepo,
    private readonly operations: OperationsRepo,
    private readonly store: StateStore,
    private readonly audit: AuditLog,
    private readonly providers: ProviderRegistry,
    private readonly engine: HealthEngine,
    private readonly replication: ReplicationService,
    private readonly checkDeps: CheckDeps,
    private readonly opts: OrchestratorOptions = {},
  ) {}

  private sleep(ms: number) {
    return this.opts.sleep ? this.opts.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  /** Waits for a background operation (tests, graceful shutdown). */
  async wait(operationId: string): Promise<void> {
    await this.running.get(operationId);
  }

  async waitAll(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  private async sitesFor(targetSiteId: string): Promise<{ source: Site; target: Site }> {
    const ctl = await this.store.controller();
    const sites = await this.repos.sites.list();
    const target = sites.find((s) => s.id === targetSiteId);
    if (!target) throw new PreconditionError('Unknown target site', []);
    const source = sites.find((s) => s.id === ctl.activeSiteId);
    if (!source) throw new PreconditionError('No active site recorded; run Reconcile first', []);
    if (source.id === target.id) throw new PreconditionError(`${target.name} is already the active site`, []);
    return { source, target };
  }

  private context(plan: FailoverPlan, dryRun: boolean, actor: Actor, operationId: string | null, acknowledged: string[]): StepContext {
    return {
      plan,
      dryRun,
      actor,
      operationId,
      acknowledged: new Set(acknowledged),
      blockers: new Map(),
      changes: new ChangeExecutor(this.audit, dryRun, { actor, operationId }),
      repos: this.repos,
      providers: this.providers,
      engine: this.engine,
      replication: this.replication,
      checkDeps: this.checkDeps,
      audit: this.audit,
      pollMs: this.opts.pollMs ?? 2000,
      isCancelled: async () => (operationId ? this.operations.isCancelRequested(operationId) : false),
      sleep: (ms) => this.sleep(ms),
      maxDataLossSeconds: null,
      dnsResults: [],
    };
  }

  private async runStep(ctx: StepContext, step: StepDef, seq: number, hooks: Hooks): Promise<StepReport> {
    const stepId = ctx.operationId ? await this.operations.startStep(ctx.operationId, seq, step.key, step.name) : null;
    if (ctx.operationId) await this.operations.setStage(ctx.operationId, step.key);
    let out: StepOutcome;
    try {
      out = await step.run(ctx);
    } catch (e) {
      out = { status: 'FAIL', message: `Unexpected error: ${(e as Error).message}` };
    }
    const report: StepReport = { seq, key: step.key, name: step.name, status: out.status, message: out.message, details: out.details ?? {} };
    if (stepId !== null) await this.operations.finishStep(stepId, out.status, out.message, report.details);
    if (ctx.operationId && !ctx.dryRun) {
      await this.audit.write({
        severity: out.status === 'FAIL' ? 'ERROR' : out.status === 'WARNING' ? 'WARNING' : 'INFO',
        category: 'failover',
        action: `step.${step.key}`,
        message: `${step.name}: ${out.message}`,
        actor: ctx.actor,
        operationId: ctx.operationId,
        siteId: ctx.plan.target.id,
      });
    }
    await hooks.onStep?.(report);
    return report;
  }

  private verdict(steps: StepReport[], blockers: Blocker[], acknowledged: Set<string>): PreflightReport['verdict'] {
    const unresolved = blockers.filter((b) => !b.overridable || !acknowledged.has(b.key));
    if (unresolved.length || steps.some((s) => s.status === 'FAIL')) return 'NOT READY';
    if (steps.some((s) => s.status === 'WARNING') || blockers.length) return 'READY WITH WARNINGS';
    return 'READY FOR FAILOVER';
  }

  /** "Prepare Failover": live, read-only evaluation of whether the target can be promoted now. */
  async prepare(targetSiteId: string, actor: Actor, acknowledged: string[] = []): Promise<PreflightReport> {
    const { source, target } = await this.sitesFor(targetSiteId);
    const plan = await loadPlan(this.repos, source, target, await this.policies.active());
    const ctx = this.context(plan, false, actor, null, acknowledged);
    // A preflight never changes anything; NPM auto-enable is only planned.
    ctx.changes = new ChangeExecutor(this.audit, true, { actor, operationId: null });
    const steps: StepReport[] = [];
    let seq = 1;
    for (const step of VALIDATION_STEPS) steps.push(await this.runStep(ctx, step, seq++, {}));
    const blockers = [...ctx.blockers.values()];
    return {
      sourceSiteId: source.id,
      targetSiteId: target.id,
      verdict: this.verdict(steps, blockers, ctx.acknowledged),
      steps,
      blockers,
      overridable: blockers.filter((b) => b.overridable).map((b) => b.key),
      estimatedMaxDataLossSeconds: ctx.maxDataLossSeconds,
      confirmationPhrase: confirmationPhrase(target),
    };
  }

  /** "Test Failover": full simulation recorded as an operation. Never changes DNS, VMs or NPM. */
  async startDryRun(targetSiteId: string, actor: Actor): Promise<Operation> {
    const { source, target } = await this.sitesFor(targetSiteId);
    const op = await this.operations.create({
      kind: 'dry_run',
      sourceSiteId: source.id,
      targetSiteId: target.id,
      requestedBy: actor.type === 'user' ? actor.id : null,
      requestedByName: actor.name,
    });
    await this.audit.write({ severity: 'INFO', category: 'failover', action: 'dry_run.started', message: `Test failover to ${target.name} started by ${actor.name}`, actor, operationId: op.id, siteId: target.id });
    const p = this.runDryRun(op, source, target, actor).finally(() => this.running.delete(op.id));
    this.running.set(op.id, p);
    return op;
  }

  private async runDryRun(op: Operation, source: Site, target: Site, actor: Actor): Promise<void> {
    try {
      const plan = await loadPlan(this.repos, source, target, await this.policies.active());
      const ctx = this.context(plan, true, actor, op.id, []);
      const sequence: StepDef[] = [...VALIDATION_STEPS, STEPS.promoteWorkloads, STEPS.waitServices, STEPS.updateDns, STEPS.waitPropagation, STEPS.verifyTraffic];
      const steps: StepReport[] = [];
      let seq = 1;
      for (const s of sequence) steps.push(await this.runStep(ctx, s, seq++, {}));
      const blockers = [...ctx.blockers.values()];
      const verdict = this.verdict(steps, blockers, new Set());
      await this.operations.finish(op.id, {
        status: 'succeeded',
        verdict,
        summary: { blockers, plannedChanges: ctx.changes.changes, estimatedMaxDataLossSeconds: ctx.maxDataLossSeconds },
      });
      await this.audit.write({
        severity: verdict === 'NOT READY' ? 'WARNING' : 'SUCCESS',
        category: 'failover',
        action: 'dry_run.finished',
        message: `Test failover to ${target.name}: ${verdict}${blockers.length ? ` (${blockers.map((b) => b.message).join('; ')})` : ''}`,
        actor,
        operationId: op.id,
        siteId: target.id,
      });
    } catch (e) {
      await this.operations.finish(op.id, { status: 'failed', error: (e as Error).message });
    }
  }

  /**
   * "Failover Now". Runs the preflight synchronously and refuses (422) when
   * blockers are not acknowledged, so a missing override never leaves the
   * controller in FAILOVER_FAILED. Then runs the live sequence in the background.
   */
  async execute(input: { targetSiteId: string; confirm: string; acknowledge?: string[]; reason?: string; actor: Actor; canOverride: boolean }): Promise<Operation> {
    const { source, target } = await this.sitesFor(input.targetSiteId);
    if (input.confirm !== confirmationPhrase(target)) {
      throw new PreconditionError(`Type "${confirmationPhrase(target)}" to confirm`, []);
    }
    const acknowledge = [...new Set(input.acknowledge ?? [])];
    if (acknowledge.length && !input.canOverride) throw new PreconditionError('Only administrators can override failover safety checks', []);
    if (acknowledge.length && !input.reason?.trim()) throw new PreconditionError('A reason is required when overriding safety checks', []);

    const ctl = await this.store.controller();
    if (ctl.currentOperationId) throw new OperationConflictError('Another failover operation is running');
    if (!MONITORING_STATES.includes(ctl.failoverState)) {
      throw new OperationConflictError(
        ctl.failoverState === 'FAILOVER_FAILED'
          ? 'Previous failover failed; run Reconcile before starting another'
          : ctl.failoverState === 'SECONDARY_ACTIVE'
            ? 'Secondary is already active; failback is a separate operation'
            : `Cannot start a failover from state ${ctl.failoverState}`,
      );
    }

    const lockClient = await this.db.connect();
    let lockHeld = false;
    let handedOff = false;
    try {
      const { rows } = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, hashtext(current_schema())) AS ok', [OP_LOCK_KEY]);
      lockHeld = Boolean(rows[0]?.ok);
      if (!lockHeld) throw new OperationConflictError('Another failover operation is running');

      const pre = await this.prepare(target.id, input.actor, acknowledge);
      const hard = pre.blockers.filter((b) => !b.overridable);
      const unacked = pre.blockers.filter((b) => b.overridable && !acknowledge.includes(b.key));
      if (hard.length || unacked.length) {
        await this.audit.write({
          severity: 'WARNING',
          category: 'failover',
          action: 'failover.refused',
          message: `Failover to ${target.name} refused: ${[...hard, ...unacked].map((b) => b.message).join('; ')}`,
          actor: input.actor,
          siteId: target.id,
        });
        throw new PreconditionError(hard.length ? 'Failover is not safe' : 'Override required', [...hard, ...unacked]);
      }

      const op = await this.operations.create({
        kind: 'failover',
        sourceSiteId: source.id,
        targetSiteId: target.id,
        requestedBy: input.actor.type === 'user' ? input.actor.id : null,
        requestedByName: input.actor.name,
        acknowledged: acknowledge,
        overrideReason: input.reason ?? null,
      });
      await this.audit.write({
        severity: acknowledge.length ? 'CRITICAL' : 'WARNING',
        category: 'failover',
        action: acknowledge.length ? 'failover.forced' : 'failover.started',
        message: acknowledge.length
          ? `FORCED failover to ${target.name} by ${input.actor.name}, overriding ${acknowledge.join(', ')}: ${input.reason}`
          : `Failover to ${target.name} started by ${input.actor.name}`,
        actor: input.actor,
        operationId: op.id,
        siteId: target.id,
        details: { acknowledged: acknowledge, reason: input.reason ?? null },
      });
      const startedFrom = ctl.failoverState;
      await this.store.transitionFailover('BEGIN_FAILOVER', {
        actor: input.actor,
        reason: `failover to ${target.name}`,
        operationId: op.id,
        expectedVersion: ctl.version,
        set: { currentOperationId: op.id },
      });
      const p = this.runLive(op, source, target, input.actor, acknowledge, startedFrom, lockClient).finally(() => this.running.delete(op.id));
      this.running.set(op.id, p);
      handedOff = true; // runLive now owns the lock and releases it
      return op;
    } finally {
      if (!handedOff) {
        if (lockHeld) await lockClient.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [OP_LOCK_KEY]).catch(() => undefined);
        lockClient.release();
      }
    }
  }

  private async runLive(
    op: Operation,
    source: Site,
    target: Site,
    actor: Actor,
    acknowledged: string[],
    startedFrom: FailoverState,
    lockClient: DbClient,
  ): Promise<void> {
    const plan = await loadPlan(this.repos, source, target, await this.policies.active());
    const ctx = this.context(plan, false, actor, op.id, acknowledged);
    let seq = 1;
    let state: FailoverState = 'CHECK_SECONDARY';
    const steps: StepReport[] = [];

    const transition = async (ev: FailoverEvent, reason: string, set?: { activeSiteId?: string | null; currentOperationId?: string | null }) => {
      const s = await this.store.transitionFailover(ev, { actor, reason, operationId: op.id, cancelTo: startedFrom, set });
      if (s) state = s.failoverState;
    };

    const fail = async (stage: string, message: string) => {
      const changed = ctx.changes.anyApplied;
      if (!changed && CANCELLABLE_STATES.includes(state)) {
        // Nothing changed: return to where we started. The system is exactly as it was.
        await transition('CANCEL', `aborted at ${stage} before any change: ${message}`, { currentOperationId: null });
        await this.siteSafe([{ site: target, event: 'PROMOTE_FAILED', reason: 'failover aborted' }], actor, op.id, true);
        await this.operations.finish(op.id, { status: 'failed', failedStage: stage, error: message, summary: this.summary(ctx, steps) });
        await this.audit.write({
          severity: 'ERROR',
          category: 'failover',
          action: 'failover.aborted',
          message: `Failover to ${target.name} aborted at stage "${stage}" before any change; routing untouched: ${message}`,
          actor,
          operationId: op.id,
          siteId: target.id,
        });
      } else {
        await transition('STEP_FAILED', `stage ${stage} failed: ${message}`, { currentOperationId: null });
        await this.siteSafe([{ site: target, event: 'PROMOTE_FAILED', reason: `failover failed at ${stage}` }], actor, op.id, true);
        await this.operations.finish(op.id, { status: 'failed', failedStage: stage, error: message, summary: this.summary(ctx, steps) });
        await this.audit.write({
          severity: 'CRITICAL',
          category: 'failover',
          action: 'failover.failed',
          message: `FAILOVER FAILED at stage "${stage}": ${message}. Changes made: ${ctx.changes.changes.filter((c) => c.status !== 'planned').map((c) => `${c.target} (${c.status})`).join(', ') || 'none'}`,
          actor,
          operationId: op.id,
          siteId: target.id,
          details: { dns: ctx.dnsResults, changes: ctx.changes.changes },
        });
      }
    };

    const cancelled = async (stage: string) => {
      await transition('CANCEL', `cancelled by operator at ${stage}`, { currentOperationId: null });
      await this.siteSafe([{ site: target, event: 'PROMOTE_FAILED', reason: 'failover cancelled' }], actor, op.id, true);
      await this.operations.finish(op.id, { status: 'cancelled', failedStage: stage, summary: this.summary(ctx, steps) });
      await this.audit.write({
        severity: 'WARNING',
        category: 'failover',
        action: 'failover.cancelled',
        message: `Failover to ${target.name} cancelled at "${stage}"; routing untouched${ctx.changes.anyApplied ? '. Workloads already started were left running' : ''}`,
        actor,
        operationId: op.id,
        siteId: target.id,
      });
    };

    const run = async (step: StepDef): Promise<boolean> => {
      if (CANCELLABLE_STATES.includes(state) && (await ctx.isCancelled())) {
        await cancelled(step.key);
        return false;
      }
      const r = await this.runStep(ctx, step, seq++, {});
      steps.push(r);
      if (r.details.cancelled) {
        await cancelled(step.key);
        return false;
      }
      if (r.status === 'FAIL') {
        await fail(step.key, r.message);
        return false;
      }
      return true;
    };

    try {
      for (const s of VALIDATION_STEPS) if (!(await run(s))) return;
      await transition('SECONDARY_OK', `${target.name} is safe to promote`);

      await transition('PROMOTE', `promoting ${target.name}`);
      await this.siteSafe([{ site: target, event: 'PROMOTE_START', reason: 'failover in progress' }], actor, op.id);
      if (!(await run(STEPS.promoteWorkloads))) return;
      if (!(await run(STEPS.waitServices))) return;
      if (!(await run(withKey(STEPS.validateNpm, 'revalidate_npm', 'Re-validate Nginx Proxy Manager')))) return;
      if (!(await run(withKey(STEPS.validateTunnel, 'revalidate_tunnel', 'Re-validate Cloudflare Tunnel')))) return;

      if (await ctx.isCancelled()) return void (await cancelled('update_dns'));
      await transition('PROMOTED', `${target.name} workloads healthy; changing routing`);
      if (!(await run(STEPS.updateDns))) return;
      if (!(await run(STEPS.waitPropagation))) return;
      await transition('ROUTING_UPDATED', 'DNS updated; verifying traffic');
      if (!(await run(STEPS.verifyTraffic))) return;

      // Mark active: apps, sites and controller.
      for (const a of plan.apps) await this.repos.applications.update(a.app.id, { activeSiteId: target.id });
      const sourceState = (await this.store.siteStates()).get(source.id)?.state;
      const sourceEvent = sourceState === 'FAILED' ? null : acknowledged.includes('primary.reachable') ? 'RECONCILE_STANDBY' : 'CONFIRMED_FAILED';
      await this.store.transitionSites(
        [
          ...(sourceEvent
            ? [{ site: source, event: sourceEvent as 'RECONCILE_STANDBY' | 'CONFIRMED_FAILED', reason: sourceEvent === 'RECONCILE_STANDBY' ? 'taken out of service by planned switchover; data sync required before failback' : 'failed over' }]
            : []),
          { site: target, event: 'PROMOTED' as const, reason: 'failover complete' },
        ],
        { actor, operationId: op.id },
      );
      await transition('VERIFIED', `${target.name} ACTIVE`, { activeSiteId: target.id, currentOperationId: null });
      await this.operations.finish(op.id, { status: 'succeeded', summary: this.summary(ctx, steps) });
      await this.audit.write({ severity: 'SUCCESS', category: 'failover', action: 'failover.completed', message: `${target.name} ACTIVE`, actor, operationId: op.id, siteId: target.id });
      // Notifications are Phase 2; the audit event above is the record.
    } catch (e) {
      await fail('internal', (e as Error).message).catch(() => undefined);
    } finally {
      await this.store.clearOperation(op.id).catch(() => undefined);
      await lockClient.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [OP_LOCK_KEY]).catch(() => undefined);
      lockClient.release();
    }
  }

  private summary(ctx: StepContext, steps: StepReport[]) {
    return {
      steps: steps.map((s) => ({ key: s.key, status: s.status })),
      changes: ctx.changes.changes,
      dns: ctx.dnsResults,
      blockers: [...ctx.blockers.values()],
      estimatedMaxDataLossSeconds: ctx.maxDataLossSeconds,
    };
  }

  private async siteSafe(
    changes: Parameters<StateStore['transitionSites']>[0],
    actor: Actor,
    operationId: string,
    ignoreInvalid = false,
  ) {
    try {
      await this.store.transitionSites(changes, { actor, operationId });
    } catch (e) {
      if (!ignoreInvalid) throw e;
    }
  }

  /** Cancel a running failover. Refused once routing changes have started. */
  async cancel(actor: Actor): Promise<Operation> {
    const ctl = await this.store.controller();
    if (!ctl.currentOperationId) throw new OperationConflictError('No failover is running');
    if (!CANCELLABLE_STATES.includes(ctl.failoverState)) {
      await this.audit.write({ severity: 'WARNING', category: 'failover', action: 'failover.cancel_refused', message: `Cancel refused: routing changes already in progress (${ctl.failoverState})`, actor, operationId: ctl.currentOperationId });
      throw new OperationConflictError(`Cannot cancel in ${ctl.failoverState}: routing changes have started`);
    }
    await this.operations.requestCancel(ctl.currentOperationId);
    await this.audit.write({ severity: 'WARNING', category: 'failover', action: 'failover.cancel_requested', message: `Cancel requested by ${actor.name}`, actor, operationId: ctl.currentOperationId });
    return (await this.operations.get(ctl.currentOperationId))!;
  }

  /**
   * After FAILOVER_FAILED (or any doubt), read the managed DNS records from
   * Cloudflare and set the controller to the state they prove.
   */
  async reconcile(actor: Actor): Promise<{ outcome: 'primary' | 'secondary' | 'mixed'; records: Array<{ name: string; points: 'primary' | 'secondary' | 'other'; content: string }> }> {
    const ctl = await this.store.controller();
    if (ctl.currentOperationId) throw new OperationConflictError('A failover is running');
    const sites = await this.repos.sites.list();
    const primary = sites.find((s) => s.designatedRole === 'primary');
    const secondary = sites.find((s) => s.designatedRole === 'secondary');
    if (!primary || !secondary) throw new PreconditionError('Both a primary and a secondary site must be configured', []);
    const records: Array<{ name: string; points: 'primary' | 'secondary' | 'other'; content: string }> = [];
    for (const app of (await this.repos.applications.list()).filter((a) => a.enabled)) {
      for (const rec of await this.repos.dnsRecords.list({ applicationId: app.id })) {
        const zone = await this.repos.zones.get(rec.zoneId);
        if (!zone) continue;
        const { provider } = await this.providers.cloudflare(zone.cloudflareAccountId);
        const live = await provider.getDnsRecord(zone.zoneId, rec.recordId);
        records.push({
          name: rec.name,
          content: live.content,
          points: live.content === rec.primaryContent ? 'primary' : live.content === rec.secondaryContent ? 'secondary' : 'other',
        });
      }
    }
    const allPrimary = records.length > 0 && records.every((r) => r.points === 'primary');
    const allSecondary = records.length > 0 && records.every((r) => r.points === 'secondary');
    if (!allPrimary && !allSecondary) {
      await this.audit.write({
        severity: 'CRITICAL',
        category: 'failover',
        action: 'reconcile.mixed',
        message: `Reconcile found mixed routing: ${records.map((r) => `${r.name} → ${r.points}`).join(', ') || 'no managed records'}. Manual correction required`,
        actor,
        details: { records },
      });
      return { outcome: 'mixed', records };
    }
    const serving = allPrimary ? primary : secondary;
    const standby = allPrimary ? secondary : primary;
    const alreadyConsistent = allPrimary ? MONITORING_STATES.includes(ctl.failoverState) : ctl.failoverState === 'SECONDARY_ACTIVE';
    if (!alreadyConsistent) {
      await this.store.transitionFailover(allPrimary ? 'RECONCILE_PRIMARY' : 'RECONCILE_SECONDARY', {
        actor,
        reason: `DNS records all point to ${serving.name}`,
        set: { activeSiteId: serving.id },
      });
    }
    const states = await this.store.siteStates();
    const changes: Parameters<StateStore['transitionSites']>[0] = [];
    const st = states.get(standby.id)?.state;
    if (st && ['PRIMARY', 'ACTIVE', 'DEGRADED', 'PROMOTING'].includes(st)) changes.push({ site: standby, event: 'RECONCILE_STANDBY', reason: 'reconciled from DNS' });
    const sv = states.get(serving.id)?.state;
    if (sv && !['PRIMARY', 'ACTIVE', 'DEGRADED'].includes(sv)) changes.push({ site: serving, event: 'RECONCILE_SERVING', reason: 'reconciled from DNS' });
    if (changes.length) await this.store.transitionSites(changes, { actor });
    for (const app of await this.repos.applications.list()) await this.repos.applications.update(app.id, { activeSiteId: serving.id });
    await this.audit.write({ severity: 'SUCCESS', category: 'failover', action: 'reconcile.done', message: `Reconciled: all managed records point to ${serving.name}`, actor, details: { records } });
    return { outcome: allPrimary ? 'primary' : 'secondary', records };
  }
}
