import type { Application, Workload } from '../domain/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Repos } from '../repos/index.js';

export type ReplicationSafety = 'SAFE' | 'WARNING' | 'UNSAFE' | 'UNKNOWN';

export interface WorkloadReplication {
  workloadId: string;
  vmid: number;
  source: Workload['replicationSource'];
  lastSync: Date | null;
  ageSeconds: number | null;
  message: string;
}

export interface ReplicationAssessment {
  applicationId: string;
  slug: string;
  siteId: string;
  safety: ReplicationSafety;
  /** Worst (oldest) age across the app's workloads at the site. */
  ageSeconds: number | null;
  lastSync: Date | null;
  maxAgeSeconds: number;
  message: string;
  workloads: WorkloadReplication[];
}

/** Fraction of the limit at which replication age becomes a WARNING. */
const WARNING_RATIO = 0.8;

export function classifyAge(ageSeconds: number | null, maxAgeSeconds: number): ReplicationSafety {
  if (ageSeconds === null) return 'UNKNOWN';
  if (ageSeconds > maxAgeSeconds) return 'UNSAFE';
  if (ageSeconds > maxAgeSeconds * WARNING_RATIO) return 'WARNING';
  return 'SAFE';
}

export const fmtAge = (s: number) => (s < 120 ? `${Math.round(s)} seconds` : s < 7200 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`);

/**
 * Determines how current the standby copy of an application is at a site.
 * "Backup available" is not "replication current": the age is measured from
 * the newest *successful* replication or backup of the guest whose data the
 * standby would run on.
 */
export class ReplicationService {
  constructor(
    private readonly repos: Repos,
    private readonly providers: ProviderRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async assess(app: Application, siteId: string): Promise<ReplicationAssessment> {
    const workloads = (await this.repos.workloads.list({ applicationId: app.id, siteId })).filter((w) => w.replicationSource !== 'none');
    const results: WorkloadReplication[] = [];
    for (const w of workloads) results.push(await this.forWorkload(w));

    const base = { applicationId: app.id, slug: app.slug, siteId, maxAgeSeconds: app.maxReplicationAgeSeconds, workloads: results };
    if (!results.length) {
      return { ...base, safety: 'UNKNOWN', ageSeconds: null, lastSync: null, message: `${app.name}: no replication source configured, data age unknown` };
    }
    const unknown = results.find((r) => r.ageSeconds === null);
    if (unknown) return { ...base, safety: 'UNKNOWN', ageSeconds: null, lastSync: null, message: `${app.name}: ${unknown.message}` };
    const worst = results.reduce((a, b) => (b.ageSeconds! > a.ageSeconds! ? b : a));
    const safety = classifyAge(worst.ageSeconds, app.maxReplicationAgeSeconds);
    const lim = fmtAge(app.maxReplicationAgeSeconds);
    const message =
      safety === 'UNSAFE'
        ? `${app.name} replication is ${fmtAge(worst.ageSeconds!)} old (limit ${lim})`
        : `${app.name} replication age ${fmtAge(worst.ageSeconds!)} (limit ${lim})`;
    return { ...base, safety, ageSeconds: worst.ageSeconds, lastSync: worst.lastSync, message };
  }

  private async forWorkload(w: Workload): Promise<WorkloadReplication> {
    const vmid = w.replicationVmid ?? w.vmid;
    const base = { workloadId: w.id, vmid: w.vmid, source: w.replicationSource };
    try {
      const pve = await this.providers.proxmox(w.proxmoxInstanceId);
      let lastSync: Date | null = null;
      if (w.replicationSource === 'pve_replication') {
        const job = (await pve.replicationJobs(w.node)).find((j) => Number(j.guest) === vmid);
        if (!job) return { ...base, lastSync: null, ageSeconds: null, message: `no Proxmox replication job for guest ${vmid}` };
        if (job.last_sync) lastSync = new Date(job.last_sync * 1000);
        if (job.fail_count && job.fail_count > 0 && lastSync) {
          const age = (this.now().getTime() - lastSync.getTime()) / 1000;
          return { ...base, lastSync, ageSeconds: age, message: `replication job ${job.id} failing (${job.fail_count} failures${job.error ? `: ${job.error}` : ''})` };
        }
      } else if (w.replicationSource === 'pve_backup') {
        if (!w.backupStorage) return { ...base, lastSync: null, ageSeconds: null, message: 'backup storage not configured' };
        const backups = await pve.listBackups(w.node, w.backupStorage, vmid);
        const newest = backups.reduce((m, b) => Math.max(m, b.ctime), 0);
        if (newest) lastSync = new Date(newest * 1000);
      }
      if (!lastSync) return { ...base, lastSync: null, ageSeconds: null, message: `no successful replication/backup found for guest ${vmid}` };
      const age = Math.max(0, (this.now().getTime() - lastSync.getTime()) / 1000);
      return { ...base, lastSync, ageSeconds: age, message: `last ${w.replicationSource === 'pve_backup' ? 'backup' : 'sync'} ${lastSync.toISOString()}` };
    } catch (err) {
      return { ...base, lastSync: null, ageSeconds: null, message: `cannot read replication status: ${(err as Error).message}` };
    }
  }
}
