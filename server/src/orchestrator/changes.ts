import type { AuditLog } from '../audit/audit.js';
import type { Actor } from '../domain/types.js';

export type ChangeKind = 'dns.update' | 'vm.start' | 'npm.enable';

export interface ChangeDescription {
  kind: ChangeKind;
  /** Human description of the target, e.g. "app.example.com" or "VM 220 (wordpress-b) on pve-b". */
  target: string;
  message: string;
  before?: unknown;
  after?: unknown;
  siteId?: string | null;
  applicationId?: string | null;
}

export interface RecordedChange extends ChangeDescription {
  status: 'planned' | 'applied' | 'failed';
  error?: string;
  at: Date;
}

/**
 * The only path by which an operation changes infrastructure. In plan mode
 * (dry run) the mutation is never invoked; it is recorded as "would do". In
 * live mode every change is audited before (intent) and after (result).
 */
export class ChangeExecutor {
  readonly changes: RecordedChange[] = [];

  constructor(
    private readonly audit: AuditLog,
    readonly dryRun: boolean,
    private readonly ctx: { actor: Actor; operationId: string | null },
  ) {}

  get anyApplied(): boolean {
    return this.changes.some((c) => c.status === 'applied' || c.status === 'failed');
  }

  async apply<T>(desc: ChangeDescription, mutation: () => Promise<T>): Promise<T | undefined> {
    if (this.dryRun) {
      this.changes.push({ ...desc, status: 'planned', at: new Date() });
      return undefined;
    }
    await this.audit.write({
      severity: 'INFO',
      category: 'change',
      action: `${desc.kind}.intent`,
      message: `Changing ${desc.target}: ${desc.message}`,
      actor: this.ctx.actor,
      siteId: desc.siteId,
      applicationId: desc.applicationId,
      operationId: this.ctx.operationId,
      details: { before: desc.before ?? null, after: desc.after ?? null },
    });
    try {
      const out = await mutation();
      this.changes.push({ ...desc, status: 'applied', at: new Date() });
      await this.audit.write({
        severity: 'SUCCESS',
        category: 'change',
        action: `${desc.kind}.applied`,
        message: `${desc.message} (${desc.target})`,
        actor: this.ctx.actor,
        siteId: desc.siteId,
        applicationId: desc.applicationId,
        operationId: this.ctx.operationId,
        details: { before: desc.before ?? null, after: desc.after ?? null },
      });
      return out;
    } catch (err) {
      const error = (err as Error).message;
      // A failed call may still have taken effect on the provider side; treat it as a change attempt.
      this.changes.push({ ...desc, status: 'failed', error, at: new Date() });
      await this.audit.write({
        severity: 'ERROR',
        category: 'change',
        action: `${desc.kind}.failed`,
        message: `Failed: ${desc.message} (${desc.target}): ${error}`,
        actor: this.ctx.actor,
        siteId: desc.siteId,
        applicationId: desc.applicationId,
        operationId: this.ctx.operationId,
        details: { before: desc.before ?? null, after: desc.after ?? null },
      });
      throw err;
    }
  }
}
