import type { Queryable } from '../db/pool.js';
import type { Actor } from '../domain/types.js';
import { redact, redactObject } from '../security/redact.js';
import { camelRow } from '../repos/sql.js';

export type Severity = 'DEBUG' | 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type AuditCategory = 'auth' | 'config' | 'health' | 'failover' | 'change' | 'provider' | 'system' | 'security';

export interface AuditInput {
  severity: Severity;
  category: AuditCategory;
  action: string;
  message: string;
  actor: Actor;
  siteId?: string | null;
  applicationId?: string | null;
  operationId?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditEvent {
  id: number;
  at: Date;
  severity: Severity;
  category: AuditCategory;
  action: string;
  message: string;
  actorType: 'user' | 'system';
  actorId: string | null;
  actorName: string;
  siteId: string | null;
  applicationId: string | null;
  operationId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
}

export interface AuditQuery {
  q?: string;
  severity?: Severity[];
  category?: AuditCategory[];
  siteId?: string;
  applicationId?: string;
  operationId?: string;
  from?: Date;
  to?: Date;
  before?: number;
  limit?: number;
}

export type AuditListener = (e: AuditEvent) => void;

/** Append-only audit log. Every message and detail is redacted before it is stored. */
export class AuditLog {
  private listeners: AuditListener[] = [];

  constructor(
    private readonly db: Queryable,
    private readonly secretValues: () => string[] = () => [],
  ) {}

  onEvent(l: AuditListener): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  async write(input: AuditInput, q: Queryable = this.db): Promise<AuditEvent> {
    const secrets = this.secretValues();
    const { rows } = await q.query(
      `INSERT INTO audit_events(severity, category, action, message, actor_type, actor_id, actor_name, site_id, application_id, operation_id, ip, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, at, severity, category, action, message, actor_type, actor_id, actor_name, site_id, application_id, operation_id, ip, details`,
      [
        input.severity,
        input.category,
        input.action,
        redact(input.message, secrets),
        input.actor.type,
        input.actor.type === 'user' ? input.actor.id : null,
        input.actor.name,
        input.siteId ?? null,
        input.applicationId ?? null,
        input.operationId ?? null,
        input.actor.type === 'user' ? (input.actor.ip ?? null) : null,
        JSON.stringify(redactObject(input.details ?? {}, secrets)),
      ],
    );
    const ev = camelRow<AuditEvent>(rows[0]);
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* listeners must not break auditing */
      }
    }
    return ev;
  }

  async query(f: AuditQuery): Promise<AuditEvent[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (f.q?.trim()) {
      // Full-text match, plus substring match so partial words ("wordp") still find events.
      args.push(f.q.trim());
      const n = args.length;
      where.push(`(search @@ plainto_tsquery('simple', $${n}) OR message ILIKE '%' || $${n} || '%' OR action ILIKE '%' || $${n} || '%')`);
    }
    if (f.severity?.length) add('severity = ANY(?)', f.severity);
    if (f.category?.length) add('category = ANY(?)', f.category);
    if (f.siteId) add('site_id = ?', f.siteId);
    if (f.applicationId) add('application_id = ?', f.applicationId);
    if (f.operationId) add('operation_id = ?', f.operationId);
    if (f.from) add('at >= ?', f.from);
    if (f.to) add('at <= ?', f.to);
    if (f.before) add('id < ?', f.before);
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const { rows } = await this.db.query(
      `SELECT id, at, severity, category, action, message, actor_type, actor_id, actor_name, site_id, application_id, operation_id, ip, details
       FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`,
      args,
    );
    return rows.map((r) => camelRow<AuditEvent>(r));
  }
}
