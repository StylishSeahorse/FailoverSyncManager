import type { AuditLog } from '../audit/audit.js';
import { withTransaction, type Db, type DbClient } from '../db/pool.js';
import type { Actor, Site } from '../domain/types.js';
import { nextFailoverState, type FailoverEvent, type FailoverState } from './failoverMachine.js';
import { nextSiteState, servingConflict, type SiteEvent, type SiteState } from './siteMachine.js';

export interface ControllerState {
  failoverState: FailoverState;
  activeSiteId: string | null;
  currentOperationId: string | null;
  monitoringPaused: boolean;
  circuitOpen: boolean;
  version: number;
  updatedAt: Date;
}

export interface SiteStateRow {
  siteId: string;
  state: SiteState;
  reason: string;
  updatedAt: Date;
}

export class StaleStateError extends Error {
  constructor() {
    super('Controller state changed concurrently; re-read and retry');
    this.name = 'StaleStateError';
  }
}

export class SplitBrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitBrainError';
  }
}

const mapController = (r: Record<string, unknown>): ControllerState => ({
  failoverState: r.failover_state as FailoverState,
  activeSiteId: (r.active_site_id as string | null) ?? null,
  currentOperationId: (r.current_operation_id as string | null) ?? null,
  monitoringPaused: Boolean(r.monitoring_paused),
  circuitOpen: Boolean(r.circuit_open),
  version: Number(r.version),
  updatedAt: r.updated_at as Date,
});

/**
 * Persists both state machines. Every transition runs in a transaction with a
 * row lock, writes a state_transitions row and an audit event, and is rejected
 * if it would leave two sites serving.
 */
export class StateStore {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
  ) {}

  /** Creates initial rows for any site or controller state that does not exist yet. */
  async ensureInitialised(sites: Site[]): Promise<void> {
    const primary = sites.find((s) => s.designatedRole === 'primary');
    await withTransaction(this.db, async (c) => {
      await c.query(
        `INSERT INTO controller_state(id, failover_state, active_site_id) VALUES (1, 'HEALTHY_PRIMARY', $1) ON CONFLICT (id) DO NOTHING`,
        [primary?.id ?? null],
      );
      await c.query(`UPDATE controller_state SET active_site_id = $1 WHERE id = 1 AND active_site_id IS NULL`, [primary?.id ?? null]);
      for (const s of sites) {
        await c.query(`INSERT INTO site_states(site_id, state) VALUES ($1, $2) ON CONFLICT (site_id) DO NOTHING`, [
          s.id,
          s.designatedRole === 'primary' ? 'PRIMARY' : 'SECONDARY',
        ]);
      }
    });
  }

  async controller(q: Pick<Db, 'query'> = this.db): Promise<ControllerState> {
    const { rows } = await q.query('SELECT * FROM controller_state WHERE id = 1');
    if (!rows[0]) throw new Error('Controller state not initialised');
    return mapController(rows[0]);
  }

  async siteStates(): Promise<Map<string, SiteStateRow>> {
    const { rows } = await this.db.query('SELECT site_id, state, reason, updated_at FROM site_states');
    return new Map(rows.map((r) => [r.site_id as string, { siteId: r.site_id, state: r.state, reason: r.reason, updatedAt: r.updated_at }]));
  }

  async transitionFailover(
    event: FailoverEvent,
    opts: {
      actor: Actor;
      reason: string;
      operationId?: string | null;
      cancelTo?: FailoverState;
      expectedVersion?: number;
      /** Only apply if the current state is one of these (used by monitoring to avoid racing operations). */
      onlyFrom?: readonly FailoverState[];
      set?: { activeSiteId?: string | null; currentOperationId?: string | null };
    },
  ): Promise<ControllerState | null> {
    return withTransaction(this.db, async (c) => {
      const { rows } = await c.query('SELECT * FROM controller_state WHERE id = 1 FOR UPDATE');
      if (!rows[0]) throw new Error('Controller state not initialised');
      const cur = mapController(rows[0]);
      if (opts.expectedVersion !== undefined && cur.version !== opts.expectedVersion) throw new StaleStateError();
      if (opts.onlyFrom && !opts.onlyFrom.includes(cur.failoverState)) return null;
      const to = nextFailoverState(cur.failoverState, event, opts.cancelTo);
      const set = opts.set ?? {};
      const upd = await c.query(
        `UPDATE controller_state SET failover_state = $1,
           active_site_id = CASE WHEN $2::boolean THEN $3::uuid ELSE active_site_id END,
           current_operation_id = CASE WHEN $4::boolean THEN $5::uuid ELSE current_operation_id END,
           version = version + 1, updated_at = now()
         WHERE id = 1 RETURNING *`,
        [to, 'activeSiteId' in set, set.activeSiteId ?? null, 'currentOperationId' in set, set.currentOperationId ?? null],
      );
      await this.logTransition(c, 'failover', cur.failoverState, to, event, opts);
      const critical = to === 'FAILOVER_FAILED' || to === 'PRIMARY_CONFIRMED_FAILED';
      await this.audit.write(
        {
          severity: critical ? 'CRITICAL' : to === 'SECONDARY_ACTIVE' ? 'SUCCESS' : 'INFO',
          category: 'failover',
          action: 'state.transition',
          message: `Controller state ${cur.failoverState} → ${to}${opts.reason ? `: ${opts.reason}` : ''}`,
          actor: opts.actor,
          operationId: opts.operationId ?? null,
          details: { from: cur.failoverState, to, event },
        },
        c,
      );
      return mapController(upd.rows[0]);
    });
  }

  /** Applies several site transitions atomically; rejects the batch if two sites would end up serving. */
  async transitionSites(
    changes: Array<{ site: Site; event: SiteEvent; reason: string }>,
    opts: { actor: Actor; operationId?: string | null },
  ): Promise<void> {
    await withTransaction(this.db, async (c) => {
      const { rows } = await c.query(
        `SELECT ss.site_id, ss.state, s.code FROM site_states ss JOIN sites s ON s.id = ss.site_id ORDER BY s.code FOR UPDATE OF ss`,
      );
      const proposed = new Map(rows.map((r) => [r.site_id as string, { code: r.code as string, state: r.state as SiteState }]));
      const applied: Array<{ site: Site; from: SiteState; to: SiteState; event: SiteEvent; reason: string }> = [];
      for (const ch of changes) {
        const cur = proposed.get(ch.site.id);
        if (!cur) throw new Error(`No state for site ${ch.site.code}`);
        const to = nextSiteState(cur.state, ch.event, { designatedRole: ch.site.designatedRole });
        applied.push({ site: ch.site, from: cur.state, to, event: ch.event, reason: ch.reason });
        proposed.set(ch.site.id, { code: cur.code, state: to });
      }
      const conflict = servingConflict([...proposed.values()]);
      if (conflict) {
        await this.audit.write({ severity: 'CRITICAL', category: 'failover', action: 'split_brain.prevented', message: conflict, actor: opts.actor, operationId: opts.operationId ?? null });
        throw new SplitBrainError(conflict);
      }
      for (const a of applied) {
        if (a.from === a.to) continue;
        await c.query(`UPDATE site_states SET state = $2, reason = $3, version = version + 1, updated_at = now() WHERE site_id = $1`, [a.site.id, a.to, a.reason]);
        await this.logTransition(c, `site:${a.site.code}`, a.from, a.to, a.event, { actor: opts.actor, reason: a.reason, operationId: opts.operationId });
        await this.audit.write(
          {
            severity: a.to === 'FAILED' ? 'CRITICAL' : a.to === 'ACTIVE' ? 'SUCCESS' : a.to === 'DEGRADED' ? 'WARNING' : 'INFO',
            category: 'failover',
            action: 'site.transition',
            message: `${a.site.name} ${a.from} → ${a.to}${a.reason ? `: ${a.reason}` : ''}`,
            actor: opts.actor,
            siteId: a.site.id,
            operationId: opts.operationId ?? null,
            details: { from: a.from, to: a.to, event: a.event },
          },
          c,
        );
      }
    });
  }

  async setMonitoringPaused(paused: boolean, actor: Actor): Promise<void> {
    await this.db.query('UPDATE controller_state SET monitoring_paused = $1, version = version + 1, updated_at = now() WHERE id = 1', [paused]);
    await this.audit.write({
      severity: 'WARNING',
      category: 'system',
      action: paused ? 'monitoring.paused' : 'monitoring.resumed',
      message: paused ? `Monitoring paused by ${actor.name}` : `Monitoring resumed by ${actor.name}`,
      actor,
    });
  }

  async clearOperation(operationId: string): Promise<void> {
    await this.db.query('UPDATE controller_state SET current_operation_id = NULL WHERE id = 1 AND current_operation_id = $1', [operationId]);
  }

  private async logTransition(
    c: DbClient,
    machine: string,
    from: string,
    to: string,
    event: string,
    opts: { actor: Actor; reason: string; operationId?: string | null },
  ) {
    await c.query(
      `INSERT INTO state_transitions(machine, from_state, to_state, event, reason, operation_id, actor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [machine, from, to, event, opts.reason, opts.operationId ?? null, opts.actor.name],
    );
  }
}
