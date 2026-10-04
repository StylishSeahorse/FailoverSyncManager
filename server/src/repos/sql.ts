import type { Queryable } from '../db/pool.js';

export const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function camelRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out as T;
}

/**
 * Minimal table gateway. Column names are only ever taken from the
 * constructor's whitelist, never from request input, so dynamic SQL here is
 * not injectable.
 */
export class TableRepo<T extends { id: string }> {
  constructor(
    protected readonly db: Queryable,
    readonly table: string,
    private readonly writable: readonly string[],
    private readonly orderBy = 'created_at',
  ) {}

  async list(where: Record<string, unknown> = {}): Promise<T[]> {
    const keys = Object.keys(where).filter((k) => where[k] !== undefined);
    const clauses = keys.map((k, i) => `${toSnake(assertIdent(k))} = $${i + 1}`);
    const sql = `SELECT * FROM ${this.table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${this.orderBy}`;
    const { rows } = await this.db.query(sql, keys.map((k) => where[k]));
    return rows.map((r) => camelRow<T>(r));
  }

  async get(id: string): Promise<T | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? camelRow<T>(rows[0]) : null;
  }

  async create(data: Partial<T>, q: Queryable = this.db): Promise<T> {
    const keys = this.pick(data);
    const cols = keys.map(toSnake);
    const { rows } = await q.query(
      `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => serialise((data as Record<string, unknown>)[k])),
    );
    return camelRow<T>(rows[0]);
  }

  async update(id: string, patch: Partial<T>, q: Queryable = this.db): Promise<T | null> {
    if (!isUuid(id)) return null;
    const keys = this.pick(patch);
    if (!keys.length) return this.get(id);
    const sets = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`);
    const { rows } = await q.query(
      `UPDATE ${this.table} SET ${sets.join(', ')}${this.touches ? ', updated_at = now()' : ''} WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => serialise((patch as Record<string, unknown>)[k]))],
    );
    return rows[0] ? camelRow<T>(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const res = await this.db.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Tables with an updated_at column. */
  protected get touches(): boolean {
    return !['cloudflare_zones', 'tunnels'].includes(this.table);
  }

  private pick(data: Partial<T>): string[] {
    return Object.keys(data).filter((k) => this.writable.includes(k) && (data as Record<string, unknown>)[k] !== undefined);
  }
}

function serialise(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

function assertIdent(k: string): string {
  if (!/^[a-zA-Z]+$/.test(k)) throw new Error(`Invalid column ${k}`);
  return k;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
