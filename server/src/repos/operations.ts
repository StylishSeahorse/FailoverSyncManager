import type { Db } from '../db/pool.js';
import type { Operation, OperationKind, OperationStep, StepStatus } from '../domain/types.js';
import { camelRow, isUuid } from './sql.js';

export class OperationsRepo {
  constructor(private readonly db: Db) {}

  async create(op: {
    kind: OperationKind;
    sourceSiteId: string | null;
    targetSiteId: string | null;
    requestedBy: string | null;
    requestedByName: string;
    acknowledged?: string[];
    overrideReason?: string | null;
  }): Promise<Operation> {
    const { rows } = await this.db.query(
      `INSERT INTO operations(kind, status, source_site_id, target_site_id, requested_by, requested_by_name, acknowledged, override_reason)
       VALUES ($1,'running',$2,$3,$4,$5,$6,$7) RETURNING *`,
      [op.kind, op.sourceSiteId, op.targetSiteId, op.requestedBy, op.requestedByName, op.acknowledged ?? [], op.overrideReason ?? null],
    );
    return camelRow<Operation>(rows[0]);
  }

  async get(id: string): Promise<Operation | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.query('SELECT * FROM operations WHERE id = $1', [id]);
    return rows[0] ? camelRow<Operation>(rows[0]) : null;
  }

  async list(limit = 50): Promise<Operation[]> {
    const { rows } = await this.db.query('SELECT * FROM operations ORDER BY started_at DESC LIMIT $1', [Math.min(limit, 200)]);
    return rows.map((r) => camelRow<Operation>(r));
  }

  async running(): Promise<Operation[]> {
    const { rows } = await this.db.query(`SELECT * FROM operations WHERE status = 'running' ORDER BY started_at`);
    return rows.map((r) => camelRow<Operation>(r));
  }

  async setStage(id: string, stage: string): Promise<void> {
    await this.db.query('UPDATE operations SET current_stage = $2 WHERE id = $1', [id, stage]);
  }

  async requestCancel(id: string): Promise<void> {
    await this.db.query('UPDATE operations SET cancel_requested = true WHERE id = $1', [id]);
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const { rows } = await this.db.query('SELECT cancel_requested FROM operations WHERE id = $1', [id]);
    return Boolean(rows[0]?.cancel_requested);
  }

  async finish(
    id: string,
    out: { status: Operation['status']; verdict?: string | null; failedStage?: string | null; error?: string | null; summary?: Record<string, unknown> },
  ): Promise<void> {
    await this.db.query(
      `UPDATE operations SET status = $2, verdict = $3, failed_stage = $4, error = $5, summary = $6, finished_at = now(), current_stage = NULL WHERE id = $1`,
      [id, out.status, out.verdict ?? null, out.failedStage ?? null, out.error ?? null, JSON.stringify(out.summary ?? {})],
    );
  }

  async startStep(operationId: string, seq: number, key: string, name: string): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO operation_steps(operation_id, seq, key, name, status) VALUES ($1,$2,$3,$4,'RUNNING') RETURNING id`,
      [operationId, seq, key, name],
    );
    return rows[0].id as number;
  }

  async finishStep(stepId: number, status: StepStatus, message: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.db.query(`UPDATE operation_steps SET status = $2, message = $3, details = $4, finished_at = now() WHERE id = $1`, [
      stepId,
      status,
      message,
      JSON.stringify(details),
    ]);
  }

  async steps(operationId: string): Promise<OperationStep[]> {
    const { rows } = await this.db.query('SELECT * FROM operation_steps WHERE operation_id = $1 ORDER BY seq', [operationId]);
    return rows.map((r) => camelRow<OperationStep>(r));
  }

  /** Startup recovery: an operation left "running" by a crash is marked failed, never resumed. */
  async failOrphans(): Promise<Operation[]> {
    const { rows } = await this.db.query(
      `UPDATE operations SET status = 'failed', error = 'Controller restarted while the operation was running', failed_stage = current_stage, finished_at = now()
       WHERE status = 'running' RETURNING *`,
    );
    return rows.map((r) => camelRow<Operation>(r));
  }
}
