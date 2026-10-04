import type { Db } from '../db/pool.js';
import type { Policy } from '../domain/types.js';
import { camelRow, toSnake } from './sql.js';

export const POLICY_FIELDS = [
  'automaticFailover',
  'automaticFailback',
  'consecutiveFailures',
  'minimumFailureDurationSeconds',
  'recoveryConsecutiveSuccesses',
  'requiredFailedGroups',
  'requireNonSdwanFailure',
  'minimumSecondaryHealth',
  'serviceWaitTimeoutSeconds',
  'propagationWaitSeconds',
  'verifyTimeoutSeconds',
  'circuitBreakerMaxFailovers',
  'circuitBreakerWindowSeconds',
] as const;

export class PolicyRepo {
  constructor(private readonly db: Db) {}

  async active(): Promise<Policy> {
    const { rows } = await this.db.query('SELECT * FROM policies WHERE is_active LIMIT 1');
    if (rows[0]) return camelRow<Policy>(rows[0]);
    const ins = await this.db.query(
      `INSERT INTO policies(name, is_active) VALUES ('Default', true) ON CONFLICT (name) DO UPDATE SET is_active = true RETURNING *`,
    );
    return camelRow<Policy>(ins.rows[0]);
  }

  async updateActive(patch: Partial<Pick<Policy, (typeof POLICY_FIELDS)[number]>>): Promise<Policy> {
    const cur = await this.active();
    const keys = POLICY_FIELDS.filter((k) => patch[k] !== undefined);
    if (!keys.length) return cur;
    const { rows } = await this.db.query(
      `UPDATE policies SET ${keys.map((k, i) => `${toSnake(k)} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [cur.id, ...keys.map((k) => patch[k])],
    );
    return camelRow<Policy>(rows[0]);
  }
}
