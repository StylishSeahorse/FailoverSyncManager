import type { Db } from '../db/pool.js';
import type { HealthCheckState } from '../domain/types.js';
import { initialState, type EvaluatorState } from '../health/evaluator.js';
import { camelRow } from './sql.js';

export class HealthStateRepo {
  constructor(private readonly db: Db) {}

  async all(): Promise<Map<string, HealthCheckState>> {
    const { rows } = await this.db.query('SELECT * FROM health_check_state');
    return new Map(rows.map((r) => [r.check_id as string, camelRow<HealthCheckState>(r)]));
  }

  async get(checkId: string): Promise<EvaluatorState> {
    const { rows } = await this.db.query('SELECT * FROM health_check_state WHERE check_id = $1', [checkId]);
    if (!rows[0]) return initialState();
    const { checkId: _c, ...rest } = camelRow<HealthCheckState>(rows[0]);
    return rest;
  }

  async save(checkId: string, s: EvaluatorState): Promise<void> {
    await this.db.query(
      `INSERT INTO health_check_state(check_id, status, consecutive_failures, consecutive_successes, first_failure_at, last_success_at, last_result_at, last_latency_ms, last_message, last_observed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (check_id) DO UPDATE SET status = EXCLUDED.status, consecutive_failures = EXCLUDED.consecutive_failures,
         consecutive_successes = EXCLUDED.consecutive_successes, first_failure_at = EXCLUDED.first_failure_at,
         last_success_at = EXCLUDED.last_success_at, last_result_at = EXCLUDED.last_result_at, last_latency_ms = EXCLUDED.last_latency_ms,
         last_message = EXCLUDED.last_message, last_observed = EXCLUDED.last_observed`,
      [
        checkId,
        s.status,
        s.consecutiveFailures,
        s.consecutiveSuccesses,
        s.firstFailureAt,
        s.lastSuccessAt,
        s.lastResultAt,
        s.lastLatencyMs,
        s.lastMessage,
        JSON.stringify(s.lastObserved ?? {}),
      ],
    );
  }

  async recordResult(checkId: string, ok: boolean, latencyMs: number | null, message: string, observed: Record<string, unknown>, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO health_check_results(check_id, ok, latency_ms, message, observed, checked_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [checkId, ok, latencyMs, message, JSON.stringify(observed), at],
    );
  }

  async results(checkId: string, limit = 100) {
    const { rows } = await this.db.query(
      'SELECT ok, latency_ms, message, observed, checked_at FROM health_check_results WHERE check_id = $1 ORDER BY checked_at DESC LIMIT $2',
      [checkId, Math.min(limit, 1000)],
    );
    return rows.map((r) => camelRow<{ ok: boolean; latencyMs: number | null; message: string; observed: unknown; checkedAt: Date }>(r));
  }

  async prune(olderThanDays: number): Promise<number> {
    const r = await this.db.query(`DELETE FROM health_check_results WHERE checked_at < now() - ($1 || ' days')::interval`, [String(olderThanDays)]);
    return r.rowCount ?? 0;
  }
}
